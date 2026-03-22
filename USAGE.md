# t2-agc Usage Guide

A practical reference for the temporal ordering rules, lifecycle constraints, and
observable behaviour of the t2-agc runtime.

---

## The Canonical Setup Sequence

Every program using t2-agc follows the same top-level ordering:

```
init_runtime()
  │
  ├─ spawn(fn, args, priority, capSet)   ← one or more times
  │
  ├─ send(pid, msg)                      ← optional: pre-seed mailboxes
  │
  └─ run()                               ← synchronous; blocks until idle
       │
       └─ inspect shared state / scheduler.tasks / agc_codes_emitted
```

Each phase has hard dependencies on the previous one.

---

## Phase 1: `init_runtime()`

**Must be called before anything else.**

`init_runtime()` creates a fresh `Scheduler` instance and installs it at
`globalThis.__t2agc__.scheduler`. Every downstream function — `spawn`, `send`,
`run`, and `get_global_scheduler` — reads from that slot. If `init_runtime()`
has not been called, they all fail immediately with a property-of-undefined
error.

```t2
(init_runtime)       ;; always first
```

`init_runtime()` is idempotent in the sense that calling it again in a new test
resets state completely, which is the recommended pattern for test isolation:
each `it` block should begin with its own `(init_runtime)`.

---

## Phase 2: `spawn(fn, args, priority, capabilitySet)`

**After `init_runtime()`, before `run()`.**

Returns a numeric pid. The task is registered in the scheduler's `tasks` Map and
enqueued into the appropriate priority run queue, but **no code runs yet** —
execution only begins when `run()` is called.

### Priority

Tasks are scheduled in strict priority order: `"critical"` → `"high"` →
`"normal"` → `"low"` → `"idle"`. This is a scheduling order, not preemption —
a running task is never interrupted mid-slice; priority only determines which
task is dequeued next when the scheduler loops.

### Capability sets are fixed at spawn time

The `Set<Capability>` passed to `spawn` is the task's permanent authority token
set. There is no mechanism to add or revoke capabilities after spawn. Plan
capability grants before calling `spawn`.

```t2
(let (log_cap) (make_log_capability))
(let (pid) (spawn my_fn (array) "normal" (new Set (array log_cap))))
```

When a task yields an `effect` primitive, the scheduler checks
`task.capabilities.has(capability)`. If the exact capability object is absent
(identity check, not structural equality), the task is crashed with `AGC-CAP500`
before the effect is dispatched.

### Task generator functions

The function passed to `spawn` must be a generator function (`function*` /
`(generator-fn ...)`). The scheduler calls `gen.next(resume_val)` on each
reduction. A plain function is accepted but will produce a non-iterable object
and crash on the first tick with `AGC-S999`.

---

## Phase 3: `send(pid, msg)` — before or inside `run()`

`send` has two distinct behaviours depending on whether the target task is
currently blocked on a receive.

### Sending before `run()` (pre-seeding)

If a message is sent before `run()` is called, the target task is still in the
`"runnable"` state (it hasn't executed yet). The message is placed in the
task's mailbox. When execution begins and the task eventually yields a `receive`
primitive, `handle_receive` finds the message already sitting in the mailbox and
delivers it immediately without the task ever entering the `"waiting"` state.

This is the primary testing pattern — pre-seed all inputs before `run()`,
observe all outputs after.

### Sending from inside a running task

When task A sends to task B while the scheduler is running:

- If B is `"runnable"` or `"done"`, the message is appended to `B.mailbox`.
- If B is `"waiting"` (blocked on receive), the scheduler performs the wake-up
  path: the message is popped from the mailbox, stored as `B.pending_resume`,
  B's status is set back to `"runnable"`, and B is re-enqueued. The next call to
  `gen.next(pending_resume)` inside B's slice delivers the message as the return
  value of the `yield` expression.

### Sending to a non-existent pid

`send(9999, msg)` against a pid not in `scheduler.tasks` emits `AGC-M050` and
returns immediately. No exception is thrown.

### Mailbox overflow

Default mailbox capacity is 1000 messages; default overflow policy is
`"drop-oldest"`. When capacity is exceeded the oldest message is discarded and
`AGC-M010` is emitted. Other policies (`"drop-newest"`, `"reject"`, `"escalate"`)
can be set by calling `task.configure_mailbox(max, policy)` before `run()`.

---

## Phase 4: `run()`

**Synchronous and total.** `run()` does not return until the scheduler's run
queue is empty.

After `run()` returns, every task that received all its expected messages is in
the `"done"` state. Results should be read from a shared closure captured by the
generator function, or from `scheduler.tasks.get(pid)` for status/history
inspection.

### Termination condition and the orphaned-waiter problem

The scheduler stops when no runnable task remains **regardless of how many tasks
are still in the `"waiting"` state**. A task that yields a receive but never
receives a matching message will block forever — and when all other tasks
finish, `run()` returns, silently abandoning it.

**This means every receive must be reachable.** If task B is waiting for a
message that only task A will send, task A must not exit before sending it. A
common mistake is for the sender to crash first, leaving the receiver orphaned.

---

## Effects and capabilities

The `effect` primitive is yielded from within a task generator:

```t2
(yield (effect log_cap "info" "processing" item))
```

The scheduler verifies two conditions before dispatching:

1. The capability object is in `task.capabilities` (identity check).
2. `capability.can_perform(operation)` returns `true`.

Either failure crashes the task. `AGC-CAP500` is emitted for a missing
capability; `AGC-CAP510` for an unsupported operation.

### Currently implemented effects

| Capability | Operations | Notes |
|---|---|---|
| `log` | `info`, `warn`, `error`, `debug` | Calls `console.*` synchronously |
| `timer` | `set_timeout`, `set_interval` | Fires callbacks outside task context |
| `timer` | `sleep` | **Not implemented** — requires async scheduler |
| `io` | `fetch`, `read`, `write` | **Not implemented** — stub throws |
| `random` | `next`, `next_int`, `next_float` | Currently returns but doesn't resume generator with value (known issue: `dispatch_effect` has no explicit return) |

---

## OTP: supervisors and registries

### `restart_child(spec)`

A thin wrapper around `spawn`. It extracts `spec.start`, `spec.priority`, and
`spec.capabilities` and calls `spawn`. The ChildSpec fields `restart_policy`,
`shutdown_timeout`, and `type` are stored for the supervisor's use but are not
acted on by `restart_child` itself.

The **restart policy is only enforced when a supervisor task is running**. The
supervisor generator's message loop watches for `["exit", child_id, reason]`
messages and calls `restart_child` again according to the policy. Calling
`restart_child` in isolation, outside a supervisor, simply spawns the task once.

### Registry

The `registry_fn` generator handles `["register", name, pid]`,
`["unregister", name]`, and `["whereis", name, from]` messages. It is a
long-lived task communicating via message passing — it must be spawned and
running for lookups to work, and all interactions are asynchronous (send a query
with a reply pid, receive the answer in a separate receive).

### Supervisor

`supervisor_fn(child_specs, strategy, max_restarts, max_time)` starts all child
specs on init, then enters a receive loop listening for exit notifications. The
`"one-for-one"` strategy is the default; only the exited child is restarted.
Restart intensity (max_restarts within max_time) is tracked but not yet
enforced.

---

## AGC Diagnostic Codes

Codes are available after `run()` via the scheduler:

```t2
(let (sched) (get_global_scheduler))
(let (codes) (. sched agc_codes_emitted))
```

Note: `agc_codes_emitted` is a plain array property — access it with `(. sched
agc_codes_emitted)`, not `(sched.agc_codes_emitted)` (the latter compiles to a
method call).

| Code | Meaning |
|---|---|
| `AGC-M010` | Mailbox overflow — message dropped |
| `AGC-M020` | Slow consumer — mailbox at 75% capacity |
| `AGC-M040` | Excessive mailbox scanning |
| `AGC-M050` | Send to non-existent pid |
| `AGC-CAP500` | Effect attempted without the required capability |
| `AGC-CAP510` | Capability does not support the requested operation |
| `AGC-E001` | Effect dispatch threw an exception |
| `AGC-E050` | Slow effect (>100 ms) |
| `AGC-S100` | Overload — run queue or slice duration threshold exceeded |
| `AGC-S999` | Unknown yield primitive or unhandled task crash |

---

## Summary of Rules

| Rule | Rationale |
|---|---|
| `init_runtime()` before everything | Installs the global scheduler |
| `spawn()` before `send()` | You need a pid to address |
| All receives must be reachable | Orphaned waiters are silently abandoned at shutdown |
| Capability set is fixed at `spawn()` | No runtime grant/revoke |
| Use `(. sched field)` for property access | `(sched.field)` compiles to a call |
| Read results only after `run()` | Tasks don't execute until `run()` |
| Each test calls `init_runtime()` | Resets all state for isolation |

---

# FUTURE

## Encoding Lifecycles and Dependencies into Static Types

The temporal ordering rules above are currently enforced only at runtime — the
type system lets you call `spawn()` before `init_runtime()`, write to a task
after `run()`, or pass a plain capability object that the task doesn't hold. All
three are programmer errors that produce runtime crashes. They could instead be
made **type errors**, unreachable by construction.

### 1. The `RuntimeHandle` pattern

Replace the `globalThis` side-channel with an explicit handle threaded through
the API:

```typescript
// Today (implicit global):
init_runtime()
const pid = spawn(fn, [], "normal", caps)

// With a RuntimeHandle:
const rt: RuntimeHandle = init_runtime()
const pid: Pid<"spawned"> = rt.spawn(fn, [], "normal", caps)
rt.run()
```

`RuntimeHandle` is only produced by `init_runtime()`, so the compiler rejects
any call to `spawn`/`send`/`run` that doesn't have one in scope. Because
`RuntimeHandle` is not `globalThis`-backed there is no ambient state to forget
to reset between tests.

### 2. Phantom-typed task states

Task status transitions follow a linear state machine:

```
spawned → runnable → (waiting ↔ runnable) → done | crashed
```

Each state can be a phantom type parameter on a `Task<S>` handle:

```typescript
type Task<S extends "spawned" | "running" | "done" | "crashed"> = { pid: number; __state: S }

declare function spawn(...): Task<"spawned">
declare function run(rt: RuntimeHandle): void  // transitions all tasks
// After run(), the handle is consumed; reading a Task<"spawned"> is a type error
```

With this, attempting to read `task.result` on a `Task<"spawned">` (before
`run()`) or re-using a `Task<"done">` as a send target becomes a compile-time
error. The phantom parameter carries no runtime cost.

### 3. Capability proof tokens

Every effect call currently performs a runtime `Set.has()` check to verify the
task holds the capability. This is an *authority* check — it prevents a task
from escalating its own privileges. But a separate *reachability* check could be
encoded statically: a task function could be typed to require specific
capability tokens as parameters:

```typescript
// The type says: this task requires a LogCapability to be spawned
type LogTask = TaskFn<[LogCapability]>

// Spawn is only valid if you supply the matching capabilities
declare function spawn<Caps extends Capability[]>(
  fn: TaskFn<Caps>,
  args: [],
  priority: Priority,
  caps: CapabilitySet<Caps>  // enforces the set contains every required cap
): Pid
```

This doesn't replace the runtime identity check (capabilities are still
unforgeable at runtime) but adds a layer of proof at the call site — if you
forgot to include a capability in the set, the compiler tells you before the
task ever runs.

### 4. Protocol-typed channels

A pid is currently `number`. If pids were instead typed with the message
protocol of their owning task, `send` could be checked at compile time:

```typescript
type RegistryPid = Pid<
  | ["register", string, number]
  | ["unregister", string]
  | ["whereis", string, Pid<any>]
>

declare function send<M>(target: Pid<M>, msg: M): void
```

Sending a malformed message to a typed pid becomes a type error rather than a
silent runtime contract violation. This is essentially what Erlang's Dialyzer
attempts, and what a future `defprotocol` macro in t2-agc would statically
enforce.

### 5. LinearHandle for `run()`

`run()` is a one-shot operation on a given `RuntimeHandle` — calling it twice is
a logic error (the scheduler is already idle). A linear type or a
"session type" (borrowed from session-typed communication) could express this:
`run()` consumes the `RuntimeHandle` and returns a `PostRunHandle` that only
exposes read operations (`tasks`, `agc_codes_emitted`). The type system then
prevents accidentally calling `run()` a second time, or calling `spawn()` on an
already-run runtime.

### Feasibility in t2lang

t2lang compiles to TypeScript, so TypeScript's type system is the implementation
target. Phantom types and branded nominal types are well-supported today.
Linear/affine types require a combination of `unique symbol` brands and
single-use callbacks, which is workable but verbose. Full session types are
beyond TypeScript's current expressive power and would require a t2lang-level
static analysis pass. The `RuntimeHandle` and phantom task state patterns are
the most immediately tractable.
