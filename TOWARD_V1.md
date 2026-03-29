# Toward V1

- See also IMPLOO.md
- See also DESIGN.md

---

## t2agc V1: Identified Gaps and Bugs

### Remaining

**6. No supervision (link / monitor)**
There are no `link` or `monitor` primitives. No parent-child relationships between processes. No crash event propagation. No restart strategies. This is acknowledged as future work in both DESIGN.md and DESIGN_NEXT.md, but without crash handling (gap 5) it can't be built.

#### Implementation Plan

The prerequisite — crash handling (#5) — is now resolved. The scheduler catches exceptions, marks processes as `"crashed"` with a `crash_reason`, and emits `AGC-P999` to the execution log. This plan builds on that foundation in four phases.

##### Phase 1: Process-level link/monitor primitives

**Goal:** When a process dies (normally or via crash), other processes that care about it are notified via a message in their mailbox.

**1a. Add `links` and `monitors` sets to `Process`.**

```
Process fields to add:
  links    : Set<Pid>     — bidirectional; if A links to B, B also links to A
  monitors : Map<Pid, MonitorRef>  — unidirectional; A monitors B, B doesn't know
```

- `links` is a `Set<Pid>`. When process A links to process B, both `A.links` and `B.links` are updated. If either crashes, the other receives an exit signal.
- `monitors` is a `Map<number, Pid>` (ref → target). When A monitors B, only A holds the ref. If B dies, A gets a `["DOWN", ref, pid, reason]` message. A can cancel monitoring using the ref.

**1b. Add `LinkPrimitive` and `MonitorPrimitive` to `types.t2`.**

```
interface LinkPrimitive    { type: "link";    target: Pid }
interface MonitorPrimitive { type: "monitor"; target: Pid }
interface CancelMonitorPrimitive { type: "cancel_monitor"; ref: number }
```

Actors request these via `yield`:
```t2
(yield { type: "link", target: other_pid })
(let (ref) (yield { type: "monitor", target: other_pid }))
```

**1c. Handle link/monitor primitives in the scheduler's `run_next`.**

When the scheduler sees a yielded primitive with `type === "link"`:
- Look up both processes in the registry.
- Add each pid to the other's `links` set.
- Resume the generator with `true` (or `false` if the target doesn't exist / is already dead).

When the scheduler sees `type === "monitor"`:
- Allocate a unique monitor ref (integer counter on the scheduler or OTP).
- Store `{ ref, watcher_pid }` on the target process's `monitors_by` list (so the target knows who is watching it).
- Resume the generator with the ref.

**1d. Propagate exit signals on process death.**

In the scheduler's `run_next`, after setting `process.status = "dead"` (both in the crash and done branches), add an **exit signal propagation step**:

```
for each linked_pid in process.links:
  let linked = registry.get(linked_pid)
  if linked is not dead:
    if linked.trap_exit:
      send linked ["EXIT", process.pid, reason]
    else:
      mark linked as crashed with reason = { linked: process.pid, original: reason }
      (recursively propagate)

for each { ref, watcher_pid } in process.monitors_by:
  send watcher_pid ["DOWN", ref, process.pid, reason]
```

The `reason` is:
- `"normal"` when `res.done === true` (generator finished naturally)
- `crash_reason` when the process crashed
- `"killed"` if explicitly killed via an exit primitive

**Key design decision — `trap_exit`:** A process with `trap_exit = true` converts exit signals into messages (`["EXIT", from_pid, reason]`) instead of dying. This is how supervisors survive their children's crashes. `trap_exit` is a boolean field on `Process`, defaulting to `false`. It can be set via a yield primitive: `yield { type: "trap_exit", value: true }`.

**Phase 1 logging requirements:**

The hardest debugging problem in an actor system is answering "why are these processes dead?" when a crash cascades through links. Without causal logging, you see N dead processes and no idea which one was the root cause.

Every exit signal propagation step must log an event that captures the full causal chain:

| Event kind | Fields | Debugging question it answers |
|------------|--------|-------------------------------|
| `"link"` | `pid_a`, `pid_b`, `time` | "Are these two processes linked?" — reconstructs the link topology at any point in time. |
| `"unlink"` | `pid_a`, `pid_b`, `time` | "When was this link removed?" — explains why a crash did NOT propagate. |
| `"monitor"` | `watcher_pid`, `target_pid`, `ref`, `time` | "Who is watching whom?" — maps monitor refs back to the processes involved. |
| `"cancel_monitor"` | `watcher_pid`, `ref`, `time` | "Why didn't I get a DOWN message?" — the monitor was cancelled before the target died. |
| `"exit_signal"` | `from_pid`, `to_pid`, `reason`, `action` (`"killed"` or `"trapped"`), `time` | **Most important event.** "Why did process X die?" → follow the `exit_signal` chain backward from X to the root cause. The `action` field distinguishes whether the signal killed the target or was converted to a message (trap_exit). |
| `"trap_exit_msg"` | `to_pid`, `from_pid`, `reason`, `time` | "Why did the supervisor receive this EXIT message?" — confirms that trap_exit converted a kill into a message delivery. |

The `exit_signal` event is the single most impactful log entry in the system. When a crash cascades A→B→C→D, the log will contain:
```
exit_signal: from=A, to=B, reason=Error("bug"), action=killed
exit_signal: from=B, to=C, reason={linked: A, original: Error("bug")}, action=killed
exit_signal: from=C, to=D, reason={linked: B, original: ...}, action=killed
```
Reading this bottom-up immediately reveals the root cause (A) without inspecting any actor code.

**AGC codes for Phase 1:**

| Code | Severity | Meaning |
|------|----------|---------|
| `AGC-L001` | info | Link established between two processes |
| `AGC-L002` | info | Link removed (unlink or death cleanup) |
| `AGC-L010` | warning | Link to dead/nonexistent process (returns false) |
| `AGC-M001` | info | Monitor established |
| `AGC-M002` | info | Monitor cancelled |
| `AGC-X001` | error | Exit signal sent — target killed (crash propagation) |
| `AGC-X002` | info | Exit signal sent — target trapped (converted to message) |

**Phase 1 integration tests** (`tests/link_monitor.test.t2`):

| # | Test name | Setup | Assert |
|---|-----------|-------|--------|
| 1.1 | Link: crash propagates to linked process | A links to B. B throws. | A is dead with status `"crashed"`. |
| 1.2 | Link: normal exit propagates to linked process | A links to B. B finishes normally. | A receives exit signal (or dies if not trapping). Verify A's status is `"dead"`. |
| 1.3 | Link: bidirectional — A crashes, B dies too | A links to B. A throws. | B is dead with status `"crashed"`. |
| 1.4 | Link to nonexistent pid returns false | A yields `link` targeting pid 9999. | Yield returns `false`. A continues running. |
| 1.5 | Monitor: crash delivers DOWN message | A monitors B. B throws. | A receives `["DOWN", ref, B_pid, crash_reason]` in its mailbox. A is still alive. |
| 1.6 | Monitor: normal exit delivers DOWN with reason "normal" | A monitors B. B finishes. | A receives `["DOWN", ref, B_pid, "normal"]`. |
| 1.7 | Cancel monitoring: no DOWN after cancel | A monitors B, gets ref. A cancels monitoring using ref. B throws. | A does NOT receive a `["DOWN", ...]` message. A's mailbox is empty. |
| 1.8 | Monitor is unidirectional — B crash doesn't kill A | A monitors B (no link). B throws. | A is still alive (status `"suspended"`, waiting for receive). Only a `["DOWN", ...]` message is delivered, not a crash propagation. |
| 1.9 | trap_exit converts link signal to message | A sets `trap_exit = true`, links to B. B throws. | A receives `["EXIT", B_pid, crash_reason]` as a mailbox message. A is still alive. |
| 1.10 | trap_exit=false (default): link signal kills | A links to B (default trap_exit). B throws. | A is dead. No `["EXIT", ...]` message — A was killed directly. |
| 1.11 | Multiple links: cascade | A links B, B links C. C throws. | B dies (linked to C). A dies (linked to B). All three are dead. |
| 1.12 | Multiple monitors on same target | A and C both monitor B. B throws. | Both A and C receive `["DOWN", ...]` messages with their respective refs. |
| 1.13 | Link + monitor on same pair | A links to B and monitors B. B throws. A has trap_exit=true. | A receives both `["EXIT", B_pid, reason]` (from link) and `["DOWN", ref, B_pid, reason]` (from monitor). |

##### Phase 2: Runtime API surface

**Goal:** Expose link/monitor through the `runtime.t2` public API, matching the yield-primitive interface.

Add to `runtime.t2`:
- `link(pid)` — convenience for `yield { type: "link", target: pid }` from inside an actor. Since this is a yield primitive, it can only be used inside a generator. The runtime function is for external use (pre-run linking of root actors).
- `monitor(pid)` — same pattern, returns a monitor ref.

These are thin wrappers that call through to `OTP.link` and `OTP.monitor`, which in turn mutate the process's link/monitor sets.

**Phase 2 integration tests** (`tests/link_monitor_api.test.t2`):

| # | Test name | Setup | Assert |
|---|-----------|-------|--------|
| 2.1 | External link before run | Spawn A and B. Call `link(A_pid, B_pid)` before `run()`. B throws during run. | A dies (crash propagated via link). |
| 2.2 | External monitor before run | Spawn A and B. Call `monitor(A_pid, B_pid)` before `run()`. B finishes during run. | A receives `["DOWN", ref, B_pid, "normal"]`. |
| 2.3 | link() inside actor via yield | Actor A spawns B, then yields a link primitive to B. B later crashes. | A receives exit signal (or dies, depending on trap_exit). |
| 2.4 | monitor() inside actor via yield | Actor A spawns B, then yields a monitor primitive to B. B later crashes. | A receives `["DOWN", ref, B_pid, reason]`. Ref matches what yield returned. |

##### Phase 3: Supervisor as a plain generator function

**Goal:** Implement the supervisor as a user-space actor (not a special runtime concept), following IMPLOO.md Layer 7.

The supervisor is a generator function that:
1. Sets `trap_exit = true` on itself (so it receives `["EXIT", child_pid, reason]` as messages instead of dying).
2. Spawns children from `ChildSpec` objects, linking to each.
3. Enters a receive loop matching `["EXIT", id, reason]` and `["which_children", from]`.
4. On child crash, applies the restart strategy (`one_for_one`, `one_for_all`, `rest_for_one`).
5. Tracks restart timestamps; if `max_restarts` exceeded within `max_seconds`, the supervisor itself exits with `"shutdown"` (emitting `AGC-P010`).

**Types needed** (in `types.t2` or a new `supervisor_types.t2`):

```
interface ChildSpec {
  id:               string
  fn:               GeneratorFunction
  args:             any[]
  priority:         Priority
  restart:          "permanent" | "transient" | "temporary"
  type:             "worker" | "supervisor"
}

interface SupervisorState {
  strategy:         "one_for_one" | "one_for_all" | "rest_for_one"
  max_restarts:     number    // default 3
  max_seconds:      number    // default 5
  children:         ChildSpec[]
  child_pids:       Map<string, Pid>
  restart_log:      number[]  // timestamps of recent restarts
}
```

**Restart policy semantics:**
- `permanent` — always restart, regardless of exit reason.
- `transient` — restart only on crash (not on normal exit).
- `temporary` — never restart.

**Restart strategy semantics:**
- `one_for_one` — only restart the crashed child.
- `one_for_all` — kill and restart all children.
- `rest_for_one` — kill and restart all children that were started after the crashed one.

The supervisor implementation is a single file `src/supervisor.t2` containing `supervisor_fn` and `handle_child_exit` (a helper generator that implements restart logic).

**Phase 3 logging requirements:**

The second hardest debugging problem: "my system is in a restart loop and I don't know why." Supervisor logging must answer: (1) which child crashed, (2) what restart strategy was applied, (3) how close we are to the restart limit, and (4) what the new pid is after restart.

| Event kind | Fields | Debugging question it answers |
|------------|--------|-------------------------------|
| `"supervisor_start"` | `supervisor_pid`, `strategy`, `max_restarts`, `max_seconds`, `child_ids`, `time` | "What is this supervisor's configuration?" — recorded once at startup, establishes baseline. |
| `"child_restart"` | `supervisor_pid`, `child_id`, `old_pid`, `new_pid`, `reason`, `strategy_applied`, `restart_count`, `restart_window_remaining`, `time` | **Most important supervisor event.** "Why was this child restarted?" and "how many restarts are left before the supervisor gives up?" The `restart_count` / `restart_window_remaining` fields let you see a restart storm approaching before it hits the limit. |
| `"child_stop_no_restart"` | `supervisor_pid`, `child_id`, `pid`, `reason`, `restart_policy`, `time` | "Why wasn't this child restarted?" — the restart policy (`temporary`, or `transient` with normal exit) explains the decision. |
| `"strategy_cascade"` | `supervisor_pid`, `strategy`, `trigger_child_id`, `affected_child_ids`, `time` | "Why were these other children killed?" — for `one_for_all` and `rest_for_one`, shows exactly which children were caught in the blast radius and why. Without this, you see children dying with no direct crash and no explanation. |
| `"supervisor_shutdown"` | `supervisor_pid`, `reason` (`"restart_limit_exceeded"`), `restart_count`, `max_restarts`, `time` | "Why did the whole subtree go down?" — the supervisor itself is dying, which means its parent supervisor will receive an EXIT and may cascade further. |

**AGC codes emitted:**

| Code | Severity | Meaning |
|------|----------|---------|
| `AGC-P001` | info | Child exited normally (transient/temporary — no restart needed) |
| `AGC-P002` | warning | Child crashed — restarting (includes restart count) |
| `AGC-P010` | error | Restart limit exceeded — supervisor exits with `"shutdown"` |
| `AGC-P020` | warning | Restart storm detected (>50% of restart budget consumed in <25% of window) |

The `AGC-P002` event should include `restart_count` and `max_restarts` in its `detail` field so that a single log line tells you "restart 2/3" — you don't have to count events manually.

**Phase 3 integration tests** (`tests/supervisor.test.t2`):

| # | Test name | Setup | Assert |
|---|-----------|-------|--------|
| 3.1 | Supervisor spawns all children | Create supervisor with 3 child specs. Run. | All 3 children are alive (status not `"dead"`). Supervisor is alive. |
| 3.2 | one_for_one: crashed child is restarted | Supervisor with strategy `one_for_one`, 2 children (W1, W2). W1 throws. | W1 is restarted (new pid, alive). W2 is unaffected (same pid, still alive). Supervisor is alive. |
| 3.3 | one_for_one: other children unaffected | Same as 3.2. | W2's pid has not changed. W2 has not been restarted. |
| 3.4 | one_for_all: all children restarted on one crash | Supervisor with strategy `one_for_all`, 3 children. W2 throws. | All 3 children have new pids (all restarted). Supervisor is alive. |
| 3.5 | rest_for_one: later children restarted | Supervisor with strategy `rest_for_one`, children [W1, W2, W3] in order. W2 throws. | W1 is unaffected (same pid). W2 and W3 have new pids (restarted). |
| 3.6 | permanent child: restarted on normal exit | Child spec with `restart: "permanent"`. Child finishes normally. | Child is restarted. |
| 3.7 | transient child: restarted on crash only | Child spec with `restart: "transient"`. Child finishes normally. | Child is NOT restarted. |
| 3.8 | transient child: restarted on crash | Child spec with `restart: "transient"`. Child throws. | Child IS restarted. |
| 3.9 | temporary child: never restarted | Child spec with `restart: "temporary"`. Child throws. | Child is NOT restarted. Supervisor logs `AGC-P001`. |
| 3.10 | restart limit exceeded: supervisor exits | Supervisor with `max_restarts: 2, max_seconds: 5`. Child crashes 3 times rapidly. | Supervisor itself exits with reason `"shutdown"`. `AGC-P010` is emitted. |
| 3.11 | which_children query | Supervisor with 2 children. External actor sends `["which_children", self_pid]` to supervisor. | Receives `["children_reply", [...]]` with correct id→pid mappings. |
| 3.12 | supervisor survives child crash (trap_exit) | Supervisor is running. One child throws. | Supervisor is still alive. Its status is not `"dead"` or `"crashed"`. |
| 3.13 | nested supervisors: crash in leaf propagates up | Supervisor S1 supervises supervisor S2, which supervises worker W. W throws. | S2 restarts W. S1 is unaffected. All supervisors alive. |
| 3.14 | nested supervisors: inner supervisor exceeds restart limit | S1 supervises S2 (permanent). S2's child crashes beyond S2's restart limit. S2 exits with `"shutdown"`. | S1 restarts S2 (and S2's children). S1 is alive. |

##### Phase 4: Debugging infrastructure and cross-cutting log events

**Goal:** Make supervision visible via `__t2agc__` and add the log events that don't belong to any single phase but are critical for debugging.

**`__t2agc__` inspector additions:**
- `__t2agc__.listLinks(pid)` — returns the set of pids linked to a given process.
- `__t2agc__.listMonitors(pid)` — returns active monitor refs for a given process.
- `__t2agc__.getSupervisionTree()` — returns the tree of supervisor→children relationships (pids, child ids, restart policies). This is the single most useful debugging view for a running system.

**Cross-cutting log events** (not specific to link/monitor or supervisor, but essential for debugging):

| Event kind | Fields | Debugging question it answers |
|------------|--------|-------------------------------|
| `"mailbox_overflow"` | `pid`, `dropped_count`, `policy`, `queue_size`, `time` | **"Why did my actor never process that message?"** — silent message loss is the hardest failure mode to debug. This event is already partially implemented (MessageQueue tracks `dropped_count`) but is not yet emitted to the execution log. Must be wired up. |
| `"receive_timeout"` | `pid`, `patterns`, `mailbox_size`, `mailbox_head_preview`, `time` | **"Why is my actor stuck?"** — when a process has been suspended on a selective receive for a long time and its mailbox is non-empty, it means the patterns don't match any queued message. Logging the patterns alongside a preview of what IS in the mailbox immediately reveals the mismatch. (Requires a configurable threshold or manual trigger via `__t2agc__`.) |
| `"schedule"` | `pid`, `reason` (`"new"`, `"message_arrived"`, `"link_exit"`), `run_queue_length`, `time` | "Why was this process woken up?" — helps trace the causal chain from "message sent" to "process scheduled" to "process ran". Especially useful for diagnosing priority inversion: if a `critical` process is stuck behind many `normal` ones, this event reveals it. |

**AGC codes for cross-cutting concerns:**

| Code | Severity | Meaning |
|------|----------|---------|
| `AGC-M010` | warning | Mailbox overflow — message dropped (includes pid and drop count) |
| `AGC-M020` | warning | Selective receive stall — process suspended with non-empty mailbox, no pattern matches (potential deadlock) |

**Phase 4 integration tests** (`tests/supervision_debug.test.t2`):

| # | Test name | Setup | Assert |
|---|-----------|-------|--------|
| 4.1 | Link event appears in execution log | A links to B. | `getLog()` contains an event with `kind: "link"` and both pids. |
| 4.2 | Monitor event appears in execution log | A monitors B. | `getLog()` contains an event with `kind: "monitor"`, watcher pid, target pid, and ref. |
| 4.3 | Exit signal event appears in execution log | A links to B. B crashes. | `getLog()` contains an event with `kind: "exit_signal"`, source pid, target pid, and reason. |
| 4.4 | `__t2agc__.listLinks(pid)` returns linked pids | A links to B. | `listLinks(A_pid)` returns a set/array containing `B_pid`. `listLinks(B_pid)` contains `A_pid`. |
| 4.5 | `__t2agc__.listLinks(pid)` after death | A links to B. B dies. | `listLinks(A_pid)` no longer contains `B_pid` (cleaned up). |
| 4.6 | `__t2agc__.listMonitors(pid)` returns active refs | A monitors B with ref R. | `listMonitors(A_pid)` returns an entry with ref R and target `B_pid`. |
| 4.7 | `__t2agc__.listMonitors(pid)` after cancel | A monitors B, gets ref R. A cancels monitoring with R. | `listMonitors(A_pid)` is empty. |
| 4.8 | Supervisor restart emits AGC-P002 | Supervisor with permanent child. Child crashes and is restarted. | `getAGCEvents()` contains an event with `code: "AGC-P002"`. Detail includes `restart_count` and `max_restarts`. |
| 4.9 | Restart limit emits AGC-P010 | Supervisor with `max_restarts: 1`. Child crashes twice. | `getAGCEvents()` contains an event with `code: "AGC-P010"`. |
| 4.10 | Normal child exit emits AGC-P001 | Supervisor with transient child. Child finishes normally. | `getAGCEvents()` contains an event with `code: "AGC-P001"`. |
| 4.11 | Mailbox overflow emits AGC-M010 | Send messages to a process with `mailbox_limit: 2` until overflow. | `getAGCEvents()` contains an event with `code: "AGC-M010"`. `getLog()` contains `kind: "mailbox_overflow"` with `dropped_count >= 1`. |
| 4.12 | `getSupervisionTree()` returns tree structure | Supervisor S1 with children W1, W2. | `getSupervisionTree()` returns `[{ supervisor_pid, children: [{ id, pid, restart, type }, ...] }]`. |
| 4.13 | Exit signal chain is fully traceable | A links B, B links C. C crashes. | `getLog()` contains two `exit_signal` events in causal order: C→B then B→A. Each has `from_pid`, `to_pid`, `reason`, `action`. Reading the log backward from A's death reveals C as root cause. |
| 4.14 | strategy_cascade event on one_for_all | Supervisor with `one_for_all`, 3 children. W1 crashes. | `getLog()` contains a `strategy_cascade` event listing W2 and W3 as `affected_child_ids`. |

##### File change summary

| File | Changes |
|------|---------|
| `types.t2` | Add `LinkPrimitive`, `MonitorPrimitive`, `CancelMonitorPrimitive`, `TrapExitPrimitive` interfaces |
| `process.t2` | Add `links: Set<Pid>`, `monitors_by: Array`, `trap_exit: boolean` fields |
| `scheduler.t2` | Handle link/monitor/cancel_monitor/trap_exit primitives in `run_next`; propagate exit signals on process death |
| `otp.t2` | Add `link(pid_a, pid_b)`, `monitor(watcher, target)` methods |
| `runtime.t2` | Expose `link()`, `monitor()` in public API; add inspector helpers |
| `supervisor.t2` | **New file.** `supervisor_fn`, `handle_child_exit`, `make_supervisor_state` |
| `index.t2` | Export `supervisor.t2` |

##### Ordering and dependencies

```
Phase 1 (link/monitor primitives)
  ← depends on: crash handling (#5) [done]
  ← depends on: execution log (#12) [done]

Phase 2 (runtime API)
  ← depends on: Phase 1

Phase 3 (supervisor)
  ← depends on: Phase 1, Phase 2
  ← depends on: selective receive (#4) [done]

Phase 4 (debugging integration)
  ← depends on: Phase 1, Phase 3
```

Phases 1 and 2 can be done together. Phase 3 is the bulk of the work. Phase 4 is incremental polish.

##### What this plan intentionally defers

- **Shutdown protocols** (`ChildSpec.shutdown_timeout`). Requires timers (`after(ms, msg)`) which don't exist yet. For v1, shutdown is immediate — the supervisor simply stops re-scheduling a child.
- **Distributed supervision**. t2agc is single-runtime. No distribution primitives.
- **Named process registration in supervisor trees**. The registry actor from IMPLOO.md Layer 7.2 handles this as a separate concern.
- **Hot-swap of supervised children**. Covered in HOTSWAP.md as a post-v1 concern.

**7. Capabilities are scaffolding only**
`CapabilitySpec` is defined in `types.t2` and `spawn` accepts a `caps` argument, but the runtime passes it in as a `new Set()` and never consults it. No capability is checked at message dispatch. No actor is restricted from ambient I/O by the capability system. The field exists but has no behavioral effect.

**10. `ExecutionContext` is a single global slot, not a stack**
inter. This works for a strictly sequential scheduler, but if any async operation (a timer, an I/O callback) fires while a process is running, `get_current()` will return the wrong process or `undefined`. It also cannot support nested scopes or re-entrant scheduling. This is fine for v1's cooperative model but needs to be acknowledged as a constraint — and will become a problem when `after(ms, msg)` timers are added.

### Resolved

**1. Scheduler suspend/resume logic is broken (`scheduler.t2`) [done] **

The `run_next` method has a self-documented correctness problem. When a process yields a `receive` primitive and its mailbox is empty, the scheduler sets a fake `{ done: false }` result and leaves the process in an ambiguous state:

```
(set! res { done: false }) ;; mock a suspended state
```

A process waiting on `receive` with an empty mailbox should be removed from the run queue entirely and only re-added when a message arrives. Currently it may be rescheduled and spin. The comments in the code explicitly flag this uncertainty ("wait... in a real actor loop, if not suspended, we run it?").

**2. Duplicate scheduling on `send` (`otp.t2`) [done]  **

In `OTP.send`, after delivering a message it unconditionally calls `scheduler.schedule(process)`. There is no check for whether the process is already in the run queue. A process that is runnable (not suspended on `receive`) will be added to the run queue a second time, causing it to execute twice per scheduler cycle.

**3. Silent message loss on mailbox overflow (`message_queue.t2`) [done]  **

When the ring buffer is full, the oldest message is silently dropped with no notification:

```
(if (method-call (. this buffer) "is_full")
  (then (method-call (. this buffer) "pop"))
)
```

No AGC diagnostic event is emitted. No crash event. No configurable overflow policy. In an actor system, silent message loss is one of the hardest failure modes to debug — it produces wrong behavior at a distance with no local signal.

---

### Functional Gaps (Specified but Not Implemented)

**4. Pattern matching is not wired to the scheduler [done]  **

`IPattern`, `IPatternArg`, `ReceivePrimitive`, and `ReceiveResult` are all defined in `types.t2`. IMPLOO.md has a full design for Layers 5 and 6 covering the matcher and selective receive. But in every test, actors pass `patterns null`:

```
(let (msg) (yield { type: "receive", patterns: null }))
```

The scheduler never inspects the patterns field. All receive is effectively wildcard receive-any. Selective receive — a core semantic of the system per DESIGN.md — is not implemented.

**5. No crash handling [done]  **

If a generator function throws an exception, nothing catches it. There is no try/catch around the `coroutine.next()` calls in `run_next`. The crash propagates up through the scheduler and likely crashes the whole runtime. The structured crash event type (`{ tag: "crash", reason, actorRef, stateSnapshot }`) described in DESIGN_NEXT.md doesn't exist. There is no concept of a process dying gracefully with an observable reason.

---

### Type / Interface Inconsistencies

**8. `AGCEvent` is used as both diagnostic type and general message type [done]  **

`AGCEvent` is defined with `{ code, severity, timestamp, pid, detail }` — it is clearly a *diagnostic event* (think: structured log entry with AGC error codes). But `MessageQueue` is typed as `RingBuffer<AGCEvent>`, and `Process.send` accepts `AGCEvent`. Meanwhile, all tests send raw arrays (`["ping", 3, pid]`) as messages.

The result is that `MessageQueue` is nominally typed for diagnostic events but actually used for arbitrary actor messages. This is an impedance mismatch that will cause problems as soon as the type system is tightened — either `MessageQueue` needs to be `RingBuffer<Message>` where `Message = any[]`, or there needs to be a clear split between the diagnostic event bus and actor mailboxes.

**9. `TaskStatus` is defined twice with different values [done]  **

`types.t2` defines: `(type TaskStatus (union "runnable" "waiting" "done" "crashed"))`

`task.t2` defines: `(type TaskStatus (union "idle" "running" "completed" "failed"))`

These are different enumerations for the same concept. The scheduler uses `"done"` in some places and `"dead"` in others. `process.t2` defines its own `ProcessStatus` with `"runnable" | "running" | "suspended" | "dead"`. There are at least three partially overlapping status enumerations in the codebase.

---

### Structural / Design Gaps

**11. Mailbox capacity is hardcoded [done]  **

`new MessageQueue(100)` is hardcoded in `Process` constructor. There is no per-actor mailbox limit configuration, no system-level default, and no way to set the limit at spawn time (even though `SpawnPrimitive` has a `mailbox_limit?` field defined in `types.t2` — another case of scaffolding that isn't wired up).

**12. No execution log [done]  **

The AGC-coded diagnostic system (`AGCEvent` with severity levels) exists at the type level but there is no active event emission in the runtime. No messages are logged when processes are spawned, when messages are enqueued/dequeued, when processes die, or when the scheduler makes decisions. The `__t2agc__` global inspection object described in DESIGN.md as a core debuggability feature does not exist.

---

### Summary Table

| # | Category | Severity | Location |
|---|----------|----------|----------|
| 1 | Scheduler suspend/resume broken | Critical | `scheduler.t2` |
| 2 | Duplicate scheduling on send | Critical | `otp.t2` |
| 3 | Silent mailbox overflow | Critical | `message_queue.t2` |
| 4 | Pattern matching not wired | Gap | `scheduler.t2`, IMPLOO layers 5–6 |
| 5 | No crash handling | Gap | `scheduler.t2`, `otp.t2` |
| 6 | No supervision | Gap | entire runtime |
| 7 | Capabilities not enforced | Gap | `runtime.t2`, `otp.t2` |
| 8 | AGCEvent vs Message type confusion | Inconsistency | `types.t2`, `message_queue.t2` |
| 9 | TaskStatus defined twice, inconsistently | Inconsistency | `types.t2`, `task.t2`, `process.t2` |
| 10 | ExecutionContext is a single slot | Constraint | `execution_context.t2` |
| 11 | Mailbox capacity hardcoded | Gap | `process.t2` |
| 12 | No execution log / `__t2agc__` inspector | Gap | entire runtime |
