# Toward V1

- See also IMPLOO.md
- See also DESIGN.md

---

## t2agc V1: Identified Gaps and Bugs

### Critical Bugs

**1. Scheduler suspend/resume logic is broken (`scheduler.t2`)**

The `run_next` method has a self-documented correctness problem. When a process yields a `receive` primitive and its mailbox is empty, the scheduler sets a fake `{ done: false }` result and leaves the process in an ambiguous state:

```
(set! res (object (done false))) ;; mock a suspended state
```

A process waiting on `receive` with an empty mailbox should be removed from the run queue entirely and only re-added when a message arrives. Currently it may be rescheduled and spin. The comments in the code explicitly flag this uncertainty ("wait... in a real actor loop, if not suspended, we run it?").

**2. Duplicate scheduling on `send` (`otp.t2`)**

In `OTP.send`, after delivering a message it unconditionally calls `scheduler.schedule(process)`. There is no check for whether the process is already in the run queue. A process that is runnable (not suspended on `receive`) will be added to the run queue a second time, causing it to execute twice per scheduler cycle.

**3. Silent message loss on mailbox overflow (`message_queue.t2`)**

When the ring buffer is full, the oldest message is silently dropped with no notification:

```
(if (method-call (. this buffer) "is_full")
  (then (method-call (. this buffer) "pop"))
)
```

No AGC diagnostic event is emitted. No crash event. No configurable overflow policy. In an actor system, silent message loss is one of the hardest failure modes to debug — it produces wrong behavior at a distance with no local signal.

---

### Functional Gaps (Specified but Not Implemented)

**4. Pattern matching is not wired to the scheduler**

`IPattern`, `IPatternArg`, `ReceivePrimitive`, and `ReceiveResult` are all defined in `types.t2`. IMPLOO.md has a full design for Layers 5 and 6 covering the matcher and selective receive. But in every test, actors pass `patterns null`:

```
(let (msg) (yield (object (type "receive") (patterns null))))
```

The scheduler never inspects the patterns field. All receive is effectively wildcard receive-any. Selective receive — a core semantic of the system per DESIGN.md — is not implemented.

**5. No crash handling**

If a generator function throws an exception, nothing catches it. There is no try/catch around the `coroutine.next()` calls in `run_next`. The crash propagates up through the scheduler and likely crashes the whole runtime. The structured crash event type (`{ tag: "crash", reason, actorRef, stateSnapshot }`) described in DESIGN_NEXT.md doesn't exist. There is no concept of a process dying gracefully with an observable reason.

**6. No supervision (link / monitor)**

There are no `link` or `monitor` primitives. No parent-child relationships between processes. No crash event propagation. No restart strategies. This is acknowledged as future work in both DESIGN.md and DESIGN_NEXT.md, but without crash handling (gap 5) it can't be built.

**7. Capabilities are scaffolding only**

`CapabilitySpec` is defined in `types.t2` and `spawn` accepts a `caps` argument, but the runtime passes it in as a `new Set()` and never consults it. No capability is checked at message dispatch. No actor is restricted from ambient I/O by the capability system. The field exists but has no behavioral effect.

---

### Type / Interface Inconsistencies

**8. `AGCEvent` is used as both diagnostic type and general message type**

`AGCEvent` is defined with `{ code, severity, timestamp, pid, detail }` — it is clearly a *diagnostic event* (think: structured log entry with AGC error codes). But `MessageQueue` is typed as `RingBuffer<AGCEvent>`, and `Process.send` accepts `AGCEvent`. Meanwhile, all tests send raw arrays (`["ping", 3, pid]`) as messages.

The result is that `MessageQueue` is nominally typed for diagnostic events but actually used for arbitrary actor messages. This is an impedance mismatch that will cause problems as soon as the type system is tightened — either `MessageQueue` needs to be `RingBuffer<Message>` where `Message = any[]`, or there needs to be a clear split between the diagnostic event bus and actor mailboxes.

**9. `TaskStatus` is defined twice with different values**

`types.t2` defines: `(type TaskStatus (union "runnable" "waiting" "done" "crashed"))`

`task.t2` defines: `(type TaskStatus (union "idle" "running" "completed" "failed"))`

These are different enumerations for the same concept. The scheduler uses `"done"` in some places and `"dead"` in others. `process.t2` defines its own `ProcessStatus` with `"runnable" | "running" | "suspended" | "dead"`. There are at least three partially overlapping status enumerations in the codebase.

---

### Structural / Design Gaps

**10. `ExecutionContext` is a single global slot, not a stack**

`ExecutionContext` holds one `current_process` pointer. This works for a strictly sequential scheduler, but if any async operation (a timer, an I/O callback) fires while a process is running, `get_current()` will return the wrong process or `undefined`. It also cannot support nested scopes or re-entrant scheduling. This is fine for v1's cooperative model but needs to be acknowledged as a constraint — and will become a problem when `after(ms, msg)` timers are added.

**11. Mailbox capacity is hardcoded**

`new MessageQueue(100)` is hardcoded in `Process` constructor. There is no per-actor mailbox limit configuration, no system-level default, and no way to set the limit at spawn time (even though `SpawnPrimitive` has a `mailbox_limit?` field defined in `types.t2` — another case of scaffolding that isn't wired up).

**12. No execution log**

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
