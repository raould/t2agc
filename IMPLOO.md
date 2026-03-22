# IMPLOO.md — t2-agc Object-Oriented Implementation Plan

**Status**: Active design  
**Supersedes**: `IMPL.md` (deprecated)  
**Constraint**: No macros. No `Symbol`/`Symbol.for`. Objects and interfaces throughout.

---

## Table of Contents

- [1. Core Philosophy](#1-core-philosophy)
- [2. Implementation Layers](#2-implementation-layers)
- [3. Temporal Dependencies and Startup Order](#3-temporal-dependencies-and-startup-order)
- [Layer 0: Types and Interfaces](#layer-0-types-and-interfaces)
- [Layer 1: RingBuffer and AGCEvent](#layer-1-ringbuffer-and-agcevent)
- [Layer 2: Capability and Task](#layer-2-capability-and-task)
- [Layer 3: Scheduler](#layer-3-scheduler)
- [Layer 4: Runtime API](#layer-4-runtime-api)
- [Layer 5: Pattern Matching](#layer-5-pattern-matching)
- [Layer 6: Selective Receive](#layer-6-selective-receive)
- [Layer 7: OTP Layer](#layer-7-otp-layer)
- [Test Plan](#test-plan)

---

## 1. Core Philosophy

### 1.1 What Changed and Why

The original IMPL.md design relied on macros (`m/receive`, `m/task`, `m/defprotocol`) to transform Erlang-style pattern-match syntax into JavaScript. This approach failed because:

- Variable bindings inside `m/receive` clauses were not correctly extracted at macro-expansion time.
- `Symbol.for` keys for bindings were fragile and required macro-time transformation to be useful.
- Nested `lambda`/`let*` forms inside `defmacro` bodies triggered parser bugs.
- The macro abstraction layer obscured the runtime model from the developer.

The OO design replaces all of these with plain objects, plain functions, and plain generator functions. The full runtime model stays visible in code.

### 1.2 Guiding Rules

1. **No macros of any kind.** All runtime behaviour is expressed as plain functions and generator functions.
2. **No `Symbol` or `Symbol.for`.** All binding keys are plain strings.
3. **Objects for everything structured.** Patterns, match results, primitives, capabilities — all plain objects.
4. **Generator functions are actors.** An actor is a generator function. No wrapping macro required.
5. **Messages are tagged arrays.** `["tag", arg1, arg2, ...]` — simple, uniform, destructurable.
6. **Patterns are typed interface objects.** A pattern is an `IPattern` with a named `op` field (the message tag) and an `args` array of typed `IPatternArg` objects — no bare arrays, no untyped sentinels.
7. **No hidden state.** The scheduler, registry, and supervisor are all inspectable objects/actors.

### 1.3 IPattern and IPatternArg

A pattern is a fully-typed object. The `op` field names the expected message tag; `args` is an array of typed slot objects describing each remaining positional argument:

```ts
// Pattern for: ["register", <any name>, <any pid>]
{ op: "register", args: [bind("name"), bind("pid")] }
```

Three concrete arg types form a discriminated union:

```ts
bind("x")   // IBindSlot    — captures the value at this position into bindings.x
lit(42)     // ILiteralSlot — position must equal 42 exactly (strict equality)
_           // IWildcardSlot — matches any value, discards it (no capture)
```

No sentinel objects are mixed into untyped arrays. Every pattern is statically typed end-to-end.

---

## 2. Implementation Layers

| Layer | Contents | Status |
|-------|----------|--------|
| 0 | Type aliases and interfaces | Not started |
| 1 | `RingBuffer`, `AGCEvent` | Not started |
| 2 | `Capability`, `Task` | Not started |
| 3 | `Scheduler` | Not started |
| 4 | Runtime API (`spawn`, `send`, `run`, `init_runtime`, `RuntimeBuilder`) | Not started |
| 5 | Pattern matching (`IPattern`, `IPatternArg`, `matchPattern`, helpers) | Not started |
| 6 | Selective receive (receive primitive, decode result) | Not started |
| 7 | OTP (`registry`, `supervisor`, behaviors) | Not started |

Each layer only depends on layers below it.

---

## 3. Temporal Dependencies and Startup Order

This section answers: **in what order must objects be created and functions called for the runtime to be in a valid state?**

### 3.1 Construction order (outside any actor)

The following sequence must happen **before** `scheduler.run()` is ever called:

```
1. Construct Capability objects          — no dependencies, constructed first.
                                           Cannot be created inside a running actor.

2. Call init_runtime(options)            — constructs and returns the Scheduler.
                                           Must happen before any spawn_root or send_external.

3. Call spawn_root(scheduler, fn, ...)   — registers the root actor(s) in the Scheduler.
                                           One or more root actors must be spawned before run()
                                           or the run loop exits immediately (nothing runnable).

4. Optionally call send_external(...)    — pre-seeds a root actor's mailbox before the loop
                                           starts. Valid after spawn_root; invalid before it.

5. Call run(scheduler)                   — enters the cooperative event loop.
                                           Blocks until all tasks are done or all remaining
                                           tasks are waiting with empty mailboxes (deadlock).
```

**Invariant**: `Capability` → `Scheduler` → `Task (via spawn_root)` → `run()`

### 3.2 Construction order inside a running actor

Once `run()` is executing, an actor drives its own lifecycle through `yield` primitives:

```
1. yield { type: "self" }              → must come before any operation that needs the
                                          actor's own Pid (e.g. passing self to another actor).

2. yield { type: "spawn", ... }        → the yielded Pid is only valid after the yield
                                          returns. Do NOT use the child Pid before capturing
                                          the return value of yield.

3. yield { type: "send", to, msg }     → requires a valid Pid (from spawn or self or a
                                          message). Cannot be called before the target Pid
                                          is known.

4. yield { type: "receive", patterns } → suspends the actor. Must not be issued while the
                                          actor still has pending work that produces further
                                          yields — the scheduler will not resume until a
                                          matching message arrives.

5. yield { type: "exit", reason }      → terminal. No yield after this is ever reached.
```

**Rule**: `self` before any send-to-self; `spawn` before any send-to-child; `receive` only after all setup yields are complete and the actor is ready to block.

### 3.3 OTP startup order

When using the OTP layer the construction order is strictly bottom-up:

```
1. Create Capability objects for all workers and supervisors that need them.

2. Construct ChildSpec objects            — pure data, no ordering constraint among peers.

3. Construct SupervisorState              — wraps ChildSpecs; child_pids map starts empty.

4. spawn_root(scheduler, supervisor_fn, [state])
                                          — supervisor is spawned first, before any worker.
                                            The supervisor's generator body then issues
                                            spawn primitives for each child in turn.

5. Optionally spawn_root a Registry       — if actors will look up each other by name,
                                            the registry must be spawned and its Pid
                                            communicated to dependants *before* those
                                            dependants try to send "register" or "whereis".
                                            Preferred pattern: pass registry_pid as an arg
                                            to spawn_root, or spawn the registry first and
                                            hard-code its Pid as a well-known constant.

6. run(scheduler)                         — starts the event loop; OTP actors bootstrap
                                            themselves via their own spawn primitives from
                                            this point on.
```

**Invariant**: `Capability` → `ChildSpec` → `SupervisorState` → `spawn_root(supervisor)` → `spawn_root(registry)` (optional) → `run()`

### 3.4 What cannot be called before `init_runtime`

| Call | Before `init_runtime` | After `init_runtime`, before `run` | Inside `run` (actor) |
|---|---|---|---|
| `new Capability(spec)` | ✅ OK | ✅ OK | ⚠️ Discouraged — forge risk |
| `init_runtime(opts)` | ✅ Must be first | — | ❌ Not valid |
| `spawn_root(sched, fn)` | ❌ No scheduler yet | ✅ OK | ❌ Use yield spawn instead |
| `send_external(sched, pid, msg)` | ❌ No scheduler | ✅ OK (pre-seed) | ❌ Use yield send instead |
| `run(scheduler)` | ❌ No scheduler | ✅ Call last | ❌ Nested run forbidden |
| `yield { type: "spawn" }` | ❌ Not in actor | ❌ Not in actor | ✅ Only inside generator |
| `yield { type: "receive" }` | ❌ Not in actor | ❌ Not in actor | ✅ Only inside generator |

### 3.5 Dependency graph (static)

```
IPatternArg (pure type)
    └── IPattern (pure type)
            └── matchPattern() (pure function, no runtime needed)

Capability
    └── Task
            └── Scheduler (owns Task map)
                    ├── spawn_root()  ──→  Task registered in Scheduler
                    ├── send_external() ──→ mailbox mutation
                    └── run()
                            └── [actor generator]
                                    ├── yield spawn   ──→ new Task in Scheduler
                                    ├── yield send    ──→ mailbox mutation + try_deliver
                                    ├── yield receive ──→ Task status = "waiting"
                                    ├── yield self    ──→ returns Pid
                                    └── yield exit    ──→ Task status = "done"/"crashed"
```

---

## Layer 0: Types and Interfaces

All types live in `src/types.t2`. They are plain type aliases and interfaces — no classes yet.

### 0.1 Primitive types

```ts
type Pid        = number;           // integer task id, 0 = no task
type Priority   = "critical" | "high" | "normal" | "low" | "idle";
type TaskStatus = "runnable" | "waiting" | "done" | "crashed";
type Message    = any[];            // tagged array: [tag, ...args]
```

### 0.2 AGCEvent

```ts
interface AGCEvent {
  code:      string;    // e.g. "AGC-M010"
  severity:  "warn" | "error" | "critical";
  timestamp: number;    // performance.now() or Date.now()
  pid:       Pid;
  detail:    string;
}
```

### 0.3 CapabilitySpec

```ts
interface CapabilitySpec {
  type:       string;           // e.g. "io", "timer", "blob"
  operations: string[];         // e.g. ["read", "write"]
}
```

### 0.4 Pattern types

Three arg-slot types form a discriminated union, allowing TypeScript to narrow on `kind`:

```ts
interface IBindSlot {
  kind: "bind";
  name: string;                               // variable name to capture into
}

interface ILiteralSlot {
  kind: "literal";
  value: string | number | boolean | null;    // must match exactly (strict equality)
}

interface IWildcardSlot {
  kind: "wildcard";                           // matches any value, no capture
}

type IPatternArg = IBindSlot | ILiteralSlot | IWildcardSlot;
```

A pattern object names the expected message tag and the arg slots:

```ts
// op  matches msg[0] exactly
// args match msg[1], msg[2], ... positionally (length must match)
interface IPattern {
  op:   string;
  args: IPatternArg[];
}
```

Helper factories live in `src/match_pattern.t2` and keep usage concise:

```ts
function bind(name: string): IBindSlot    { return { kind: "bind", name }; }
function lit(v: string | number | boolean | null): ILiteralSlot { return { kind: "literal", value: v }; }
const _: IWildcardSlot = { kind: "wildcard" };
```

### 0.5 ReceivePrimitive

The object a task yields to request a selective receive:

```ts
interface ReceivePrimitive {
  type:     "receive";
  patterns: IPattern[];   // try in order; first match wins; [] = accept any message
}
```

### 0.6 ReceiveResult

The object the scheduler sends back after a successful match:

```ts
interface ReceiveResult {
  index:    number;              // which IPattern matched (0-based); 0 when patterns=[]
  message:  Message;             // the full matched message (tagged array)
  bindings: Record<string, any>; // IBindSlot name → captured value
}
```

### 0.7 SpawnPrimitive

```ts
interface SpawnPrimitive {
  type:         "spawn";
  fn:           GeneratorFunction;
  args:         any[];
  priority?:    Priority;
  capabilities?: CapabilitySpec[];
  mailbox_limit?: number;
}
```

### 0.8 SendPrimitive

```ts
interface SendPrimitive {
  type: "send";
  to:   Pid;
  msg:  Message;
}
```

### 0.9 SelfPrimitive

```ts
interface SelfPrimitive {
  type: "self";
}
```

### 0.10 ExitPrimitive

```ts
interface ExitPrimitive {
  type:   "exit";
  reason: any;
}
```

---

## Layer 1: RingBuffer and AGCEvent

### 1.1 RingBuffer

A fixed-capacity, overwriting ring buffer. Used for the three per-task event histories (effects, exceptional, critical).

```ts
class RingBuffer<T> {
  private buf:    T[];
  private head:   number;  // index of oldest entry
  private size:   number;  // current count (≤ capacity)
  readonly capacity: number;

  constructor(capacity: number);

  push(item: T): void;
  toArray(): T[];  // oldest-first
  isFull(): boolean;
  get length(): number;
}
```

**Implementation notes:**
- `push` writes at `(head + size) % capacity`, then if full advances `head`.
- `toArray` returns elements in insertion order starting from `head`.

### 1.2 AGCEvent helpers

A plain object factory — no class needed:

```ts
function makeAGCEvent(
  code:     string,
  severity: "warn" | "error" | "critical",
  pid:      Pid,
  detail:   string
): AGCEvent;
```

---

## Layer 2: Capability and Task

### 2.1 Capability

A capability is an opaque object. Actors cannot forge one; they can only use ones passed to them at spawn time or via a capability-granting message.

```ts
class Capability {
  readonly id:   number;       // unique, assigned at construction
  readonly spec: CapabilitySpec;

  constructor(spec: CapabilitySpec);

  permits(operation: string): boolean;
  toString(): string;   // "cap#<id>/<type>"
}
```

Capabilities are never created inside a running actor — they are created by the runtime initialiser or the supervisor and passed at spawn time.

### 2.2 Task

A task is a wrapper around a running generator. It holds all the actor state that the scheduler needs.

```ts
class Task {
  readonly pid:      Pid;
  readonly gen:      Generator;         // the running generator instance

  status:            TaskStatus;
  priority:          Priority;
  reductions_left:   number;            // slice budget; reset on wake-up

  mailbox:           Message[];         // append-only from external senders
  mailbox_limit:     number;            // default 1024; configurable at spawn

  capabilities:      Set<Capability>;

  effects_history:    RingBuffer<AGCEvent>;    // capacity 64
  exceptional_history: RingBuffer<AGCEvent>;  // capacity 32
  critical_history:   RingBuffer<AGCEvent>;   // capacity 16

  // The pending receive request while status === "waiting"
  pending_receive:   ReceivePrimitive | null;

  constructor(
    pid:      Pid,
    gen:      Generator,
    priority: Priority,
    caps:     Capability[],
    mailbox_limit?: number
  );
}
```

**No method logic belongs on `Task`** — it is a data holder. All behaviour lives in `Scheduler`.

---

## Layer 3: Scheduler

The scheduler is the cooperative event loop. It holds all live tasks and drives their execution.

### 3.1 Data layout

```ts
class Scheduler {
  private tasks:     Map<Pid, Task>;
  private next_pid:  number;

  // One run queue per priority level, in dispatch order:
  private queues: {
    critical: Pid[];
    high:     Pid[];
    normal:   Pid[];
    low:      Pid[];
    idle:     Pid[];
  };

  private running:   Pid | null;   // pid of currently executing task
  readonly default_reductions: number;  // configurable; default 2000
}
```

### 3.2 Core methods

```ts
class Scheduler {
  // Register a freshly created task and enqueue it
  add_task(task: Task): void;

  // Pick the highest-priority non-empty queue's head
  pick_next(): Task | null;

  // Run one task for up to task.reductions_left steps.
  // Returns when: task finishes, task blocks, or budget exhausted.
  execute_slice(task: Task): void;

  // Dispatch a primitive yielded by a generator
  handle_primitive(task: Task, primitive: any): void;

  // Re-scan the mailbox of a waiting task; wake it up if a match is found
  try_deliver(pid: Pid): void;

  // Main loop — run until all tasks are done or waiting with empty mailboxes
  run(): void;
}
```

### 3.3 `handle_primitive`

Each primitive object is dispatched on its `type` field:

```
"spawn"   → create Task, add_task, yield new Pid back to generator
"send"    → push message to target mailbox, call try_deliver(to), yield null
"receive" → store as task.pending_receive, set status="waiting", remove from queue
"self"    → yield task.pid back to generator
"exit"    → set status="done" (or "crashed" if reason ≠ "normal"), remove from queue
unknown   → log AGC-S999, crash task
```

### 3.4 `execute_slice`

```
loop:
  call gen.next(pending_result)   // pending_result is null unless we just answered a primitive
  if gen.done → mark status "done", return
  if gen.value is a primitive object → call handle_primitive(task, gen.value), return
  decrement task.reductions_left
  if reductions_left <= 0 → move task to tail of its queue, reset budget, return
```

### 3.5 `try_deliver`

Called after every `send` and at the start of `run()`:

```
for each waiting task T:
  scan T.mailbox
  for each pattern P (IPattern) in T.pending_receive.patterns (in order):
    for each message M in T.mailbox:
      result = matchPattern(P, M)
      if result ≠ null:
        remove M from T.mailbox
        T.pending_receive = null
        T.status = "runnable"
        enqueue T with pending_result = { index: i, message: M, bindings: result }
        stop scanning
```

### 3.6 Mailbox overflow

When `task.mailbox.length >= task.mailbox_limit` and a new message arrives:

- Emit `AGC-M010` (overflow, warn) to the sender's exceptional_history.
- Drop the new message (tail-drop policy).

When `task.mailbox.length > task.mailbox_limit * 0.8`:

- Emit `AGC-M020` (slow consumer, warn) to the sending task's effects_history.
- Still deliver the message.

### 3.7 Dead-pid send

If `send` targets a pid not in `tasks`:

- Emit `AGC-M050` (dead pid, warn) to the sending task's exceptional_history.
- Silently drop the message.

### 3.8 Overload detection

At the start of each `run()` cycle, count total runnable tasks. If above the overload threshold (default 500):

- Emit `AGC-S100` (overload, warn) to the scheduler's own critical_history.
- Apply proportional reduction-budget cuts to `low` and `idle` queues.

---

## Layer 4: Runtime API

These are the public-facing functions that actor code calls (via `yield` for blocking versions).

### 4.1 `init_runtime`

> **Order constraint**: must be the first runtime call. Returns the `Scheduler` that all subsequent calls require.

```ts
function init_runtime(options?: {
  default_reductions?: number;
  mailbox_limit?:      number;
  overload_threshold?: number;
}): Scheduler;
```

Creates and returns the scheduler instance. Call once at program startup before any `spawn_root`, `send_external`, or `run`.

### 4.2 `run`

> **Order constraint**: call *last*, after all root actors are spawned and any pre-seeded messages are sent. Blocks until the system is idle or all tasks have exited.

```ts
function run(scheduler: Scheduler): void;
```

Convenience alias for `scheduler.run()`.

### 4.3 `spawn_root`

> **Order constraint**: call after `init_runtime`, before `run`. Any `Capability` objects passed as `caps` must already be constructed. The returned `Pid` is valid immediately and can be passed to `send_external`.

Not called from within a running generator — outside bootstrap only:

```ts
function spawn_root(
  scheduler: Scheduler,
  fn:        GeneratorFunction,
  args?:     any[],
  priority?: Priority,
  caps?:     Capability[]
): Pid;
```

From inside an actor, spawn is requested by yielding. The new `Pid` is **not** available until after the yield returns:

```ts
// child_pid is undefined until the yield completes
const child_pid: Pid = yield {
  type:         "spawn",
  fn:           my_generator_fn,
  args:         [arg1, arg2],
  priority:     "normal",
  capabilities: [cap1]
};
// child_pid is now valid — safe to send
```

### 4.4 `send_external`

> **Order constraint**: call after `init_runtime` and after `spawn_root` has registered the target `Pid`. Calling with an unknown `Pid` emits `AGC-M050` and drops the message.

```ts
function send_external(
  scheduler: Scheduler,
  to:        Pid,
  msg:       Message
): void;
```

For use outside of an actor (e.g. test setup, event loop bridge). Inside an actor use `yield { type: "send" }` instead — calling `send_external` from inside a generator bypasses the scheduler's reduction accounting.

### 4.5 `self`

> **Order constraint**: may be called at any point inside a running generator. Fetch the `Pid` once and cache it if needed by multiple operations.

```ts
// Fetch own Pid first if the actor needs to register itself or reply
const my_pid: Pid = yield { type: "self" };
// Now safe to pass my_pid in outgoing messages
```

### 4.6 `exit`

> **Order constraint**: terminal primitive. No yield after this is ever executed. Drain or discard any pending state before issuing.

```ts
yield { type: "exit", reason: "normal" };  // clean exit
yield { type: "exit", reason: "crash" };   // abnormal exit
```

---

### 4.7 `RuntimeBuilder` — typed lifecycle factory

The temporal dependencies documented in §3 are re-stated as prose and comments. A `RuntimeBuilder` **encodes them once in the type system** using the **type-state pattern**: each builder method returns a *different interface type* that only exposes the methods valid at the next phase. A caller holding an `ICapabilityPhase` reference literally cannot call `run()` — it is not on the interface.

#### Configuration interfaces

```ts
// Options forwarded to init_runtime()
interface IRuntimeOptions {
  default_reductions?: number;
  mailbox_limit?:      number;
  overload_threshold?: number;
}

// Specification for a single root actor
interface IActorSpec {
  fn:       GeneratorFunction;
  args?:    any[];
  priority?: Priority;
  caps?:    Capability[];     // must already be constructed before building
  seed?:    Message[];        // messages pre-loaded into mailbox before run()
}
```

#### Phase marker interfaces

Each marker interface is the *only* view of the builder that a caller possesses at a given phase. Methods from other phases are invisible.

```ts
// ── Phase 1 ─────────────────────────────────────────────────────────────────
// Entry point. Capability objects must already exist before this call.
interface ICapabilityPhase {
  withCapabilities(...caps: Capability[]): ISchedulerPhase;
  withoutCapabilities(): ISchedulerPhase;    // shortcut when no caps needed
}

// ── Phase 2 ─────────────────────────────────────────────────────────────────
// Has capabilities registered. Must call initRuntime before anything else.
interface ISchedulerPhase {
  initRuntime(opts?: IRuntimeOptions): ISpawnPhase;
}

// ── Phase 3 ─────────────────────────────────────────────────────────────────
// Scheduler exists. May spawn any number of root actors and pre-seed messages.
// run() is the only terminal exit from this phase.
interface ISpawnPhase {
  spawnRoot(spec: IActorSpec): ISpawnPhase; // returns self — chain multiple spawns
  seed(pid: Pid, msg: Message): ISpawnPhase; // pre-seed a message; pid from a prior spawnRoot
  run(): void;                               // starts the event loop; builder is consumed
}
```

**Invariant enforced by the type system:**
```
createRuntime()          → ICapabilityPhase
  .withCapabilities(...) → ISchedulerPhase
  .initRuntime(...)      → ISpawnPhase
  .spawnRoot(...)        → ISpawnPhase   (may chain)
  .run()                 → void          (terminal)
```
Calling `run()` on an `ICapabilityPhase` or `ISchedulerPhase` is a **compile-time error**, not a runtime surprise.

#### Concrete implementation

`RuntimeBuilder` implements all three phase interfaces privately. The `as` casts narrow the public view to the correct phase interface — callers never hold the concrete class type.

```ts
class RuntimeBuilder implements ICapabilityPhase, ISchedulerPhase, ISpawnPhase {
  private _caps:      Capability[] = [];
  private _scheduler: Scheduler | null = null;

  // ── Phase 1 ────────────────────────────────────────────────────────────
  withCapabilities(...caps: Capability[]): ISchedulerPhase {
    this._caps = caps;
    return this as unknown as ISchedulerPhase;  // narrow; callers lose Phase 1 methods
  }

  withoutCapabilities(): ISchedulerPhase {
    return this as unknown as ISchedulerPhase;
  }

  // ── Phase 2 ────────────────────────────────────────────────────────────
  initRuntime(opts?: IRuntimeOptions): ISpawnPhase {
    this._scheduler = init_runtime(opts);       // creates Scheduler
    return this as unknown as ISpawnPhase;      // narrow; callers lose Phase 2 methods
  }

  // ── Phase 3 ────────────────────────────────────────────────────────────
  spawnRoot(spec: IActorSpec): ISpawnPhase {
    const pid = spawn_root(
      this._scheduler!,
      spec.fn,
      spec.args ?? [],
      spec.priority,
      spec.caps
    );
    for (const msg of spec.seed ?? []) {
      send_external(this._scheduler!, pid, msg);
    }
    return this;    // same phase — further spawnRoot / seed calls are valid
  }

  seed(pid: Pid, msg: Message): ISpawnPhase {
    send_external(this._scheduler!, pid, msg);
    return this;
  }

  run(): void {
    this._scheduler!.run();   // enters cooperative event loop
    // builder is consumed — no valid state after this
  }
}

// Factory function — returns only ICapabilityPhase, hiding the concrete class
function createRuntime(): ICapabilityPhase {
  return new RuntimeBuilder();
}
```

#### Usage example

```ts
const io_cap = new Capability({ type: "io", operations: ["read", "write"] });

createRuntime()
  .withCapabilities(io_cap)                    // Phase 1 → 2
  .initRuntime({ mailbox_limit: 512 })         // Phase 2 → 3
  .spawnRoot({ fn: registry_fn })              // Phase 3 (registry has no caps)
  .spawnRoot({ fn: supervisor_fn,              // Phase 3 (supervisor gets io)
               caps: [io_cap],
               args: [my_supervisor_state] })
  .run();                                      // start event loop
```

Missing a phase is a **compile error**:

```ts
// ERROR: Property 'run' does not exist on type 'ICapabilityPhase'
createRuntime().run();

// ERROR: Property 'spawnRoot' does not exist on type 'ISchedulerPhase'
createRuntime().withCapabilities().spawnRoot({ fn: registry_fn });
```

#### OTP variant

For OTP-heavy systems, extend `ISpawnPhase` with higher-level spawn helpers:

```ts
interface IOtpSpawnPhase extends ISpawnPhase {
  // Spawns a supervisor actor from a SupervisorState; returns self.
  withSupervisor(state: SupervisorState): IOtpSpawnPhase;

  // Spawns a registry actor and returns its Pid alongside the builder.
  // The Pid is available immediately for passing to subsequent actor specs.
  withRegistry(): { pid: Pid; builder: IOtpSpawnPhase };
}

function createOtpRuntime(): ICapabilityPhase; // returns IOtpSpawnPhase at Phase 3
```

#### Why this works in TypeScript

TypeScript uses **structural typing**. An interface with only `withCapabilities` and `withoutCapabilities` truly has no `run` method — there is nothing to call. The `as unknown as ISchedulerPhase` casts are implementation-internal only; the public API is entirely interface-typed. No runtime overhead: the phase interfaces are erased at compile time, leaving a plain object.

Pattern matching is a **pure utility** — it does not interact with the scheduler at all. It lives in `src/match_pattern.t2`.

### 5.1 Types and helper factories

```ts
interface IBindSlot     { kind: "bind";     name: string; }
interface ILiteralSlot  { kind: "literal";  value: string | number | boolean | null; }
interface IWildcardSlot { kind: "wildcard"; }

type IPatternArg = IBindSlot | ILiteralSlot | IWildcardSlot;

interface IPattern {
  op:   string;          // must equal message[0] exactly
  args: IPatternArg[];   // length must equal message.length - 1
}
```

Helper factories — keep pattern declarations concise and readable:

```ts
function bind(name: string): IBindSlot {
  return { kind: "bind", name };
}

function lit(value: string | number | boolean | null): ILiteralSlot {
  return { kind: "literal", value };
}

const _: IWildcardSlot = { kind: "wildcard" };
```

### 5.2 `matchPattern`

```ts
function matchPattern(
  pattern: IPattern,
  msg:     Message
): Record<string, any> | null;
```

Rules:

1. If `msg[0] !== pattern.op` (strict equality), return `null`.
2. If `msg.length - 1 !== pattern.args.length`, return `null`. (Exact arity check.)
3. For each position `i` in `pattern.args`, switch on `slot.kind`:
   - `"bind"`:     capture `msg[i + 1]` under `slot.name`.
   - `"literal"`:  if `msg[i + 1] !== slot.value`, return `null`.
   - `"wildcard"`: accept any value, no capture.
4. Return accumulated bindings object (`{}` if no bind slots).

```ts
// Bind slots
matchPattern(
  { op: "register", args: [bind("name"), bind("pid")] },
  ["register", "alice", 42]
)
// → { name: "alice", pid: 42 }

// Op mismatch
matchPattern(
  { op: "register", args: [bind("name"), bind("pid")] },
  ["whereis", "alice", 42]
)
// → null

// No args
matchPattern(
  { op: "pong", args: [] },
  ["pong"]
)
// → {}

// Literal slot
matchPattern(
  { op: "event", args: [lit("click"), bind("x"), bind("y")] },
  ["event", "click", 100, 200]
)
// → { x: 100, y: 200 }

// Literal mismatch
matchPattern(
  { op: "event", args: [lit("click"), bind("x"), bind("y")] },
  ["event", "keydown", 100, 200]
)
// → null

// Wildcard
matchPattern(
  { op: "log", args: [_, bind("msg")] },
  ["log", "INFO", "hello"]
)
// → { msg: "hello" }
```

### 5.3 Wildcards

Use `_` to skip a positional arg without capturing it. Multiple wildcards are allowed in one pattern.

### 5.4 Nested messages

`matchPattern` matches flat tagged arrays only. If a payload is itself structured, destructure it in the case body after the receive result is decoded.

---

## Layer 6: Selective Receive

Selective receive is how actors block waiting for a specific message. No macro is needed. The actor yields a `ReceivePrimitive` and the scheduler handles matching.

### 6.1 Yielding a receive request

From inside an actor, request a receive by yielding a `ReceivePrimitive`:

```ts
const result: ReceiveResult = yield {
  type: "receive",
  patterns: [
    { op: "register",   args: [bind("name"), bind("pid")] },
    { op: "unregister", args: [bind("name")] },
    { op: "whereis",    args: [bind("name"), bind("from")] }
  ]
};
```

The generator suspends. The scheduler stores the primitive in `task.pending_receive` and marks the task `"waiting"`.

When a matching message arrives, the scheduler calls `try_deliver`, finds the match, removes the message from the mailbox, and resumes the generator with a `ReceiveResult`:

```ts
{
  index:    1,                             // "unregister" pattern matched
  message:  ["unregister", "alice"],       // the full original message
  bindings: { name: "alice" }             // extracted variables
}
```

### 6.2 Decoding the result

After the yield returns, the actor decodes the result with a plain switch:

```ts
switch (result.index) {
  case 0: {
    // "register" matched
    const name: string = result.bindings.name;
    const pid:  Pid    = result.bindings.pid;
    names.set(name, pid);
    break;
  }
  case 1: {
    // "unregister" matched
    const name: string = result.bindings.name;
    names.delete(name);
    break;
  }
  case 2: {
    // "whereis" matched
    const name: string = result.bindings.name;
    const from: Pid    = result.bindings.from;
    yield { type: "send", to: from, msg: ["whereis_reply", names.get(name) ?? null] };
    break;
  }
}
```

No macro needed. No hidden variable injection. Every name is an explicit lookup into `result.bindings`.

### 6.3 Unconditional receive (accept any message)

Pass an empty `patterns` array. The scheduler matches the next message regardless of its tag or arity:

```ts
const result: ReceiveResult = yield {
  type: "receive",
  patterns: []   // accept any message
};
const msg  = result.message;      // full raw Message array
const tag  = msg[0] as string;    // the operation tag
```

When `patterns` is empty, `result.index = 0` and `result.bindings = {}` always. Use `result.message` and manual destructuring for dispatch.

### 6.4 Writing a full actor — registry example

```ts
function* registry_fn(_args: any[]): Generator {
  const names = new Map<string, Pid>();

  while (true) {
    const result: ReceiveResult = yield {
      type: "receive",
      patterns: [
        { op: "register",   args: [bind("name"), bind("pid")] },
        { op: "unregister", args: [bind("name")] },
        { op: "whereis",    args: [bind("name"), bind("from")] }
      ]
    };

    switch (result.index) {
      case 0: {
        names.set(result.bindings.name, result.bindings.pid);
        break;
      }
      case 1: {
        names.delete(result.bindings.name);
        break;
      }
      case 2: {
        const found: Pid | null = names.get(result.bindings.name) ?? null;
        yield { type: "send", to: result.bindings.from, msg: ["whereis_reply", found] };
        break;
      }
    }
  }
}
```

This is the complete registry. No macros. No Symbols.

---

## Layer 7: OTP Layer

### 7.1 Supervisor

A supervisor is a plain generator function that:

1. Spawns its children according to child specs.
2. Receives `["exit", id, reason]` messages from crashed children.
3. Applies the restart strategy to decide which children to restart.
4. Enforces restart limits and emits AGC codes on failure.

#### Child spec object

```ts
interface ChildSpec {
  id:              string;
  fn:              GeneratorFunction;
  args:            any[];
  priority:        Priority;
  capabilities:    Capability[];
  restart:         "permanent" | "transient" | "temporary";
  shutdown_timeout: number;         // ms; 0 = immediate
  type:            "worker" | "supervisor";
}
```

#### Supervisor state object

```ts
interface SupervisorState {
  strategy:        "one_for_one" | "one_for_all" | "rest_for_one";
  max_restarts:    number;    // default 3
  max_seconds:     number;    // restart count window in seconds; default 5
  children:        ChildSpec[];
  child_pids:      Map<string, Pid>;   // id → current pid
  restart_log:     number[];           // timestamps of recent restarts
}
```

#### Supervisor loop

```ts
function* supervisor_fn(state: SupervisorState): Generator {
  // Spawn all children
  for (const spec of state.children) {
    const pid: Pid = yield {
      type:         "spawn",
      fn:           spec.fn,
      args:         spec.args,
      priority:     spec.priority,
      capabilities: spec.capabilities
    };
    state.child_pids.set(spec.id, pid);
  }

  while (true) {
    const result: ReceiveResult = yield {
      type:     "receive",
      patterns: [
        { op: "exit",           args: [bind("id"), bind("reason")] },
        { op: "which_children", args: [bind("from")] }
      ]
    };

    switch (result.index) {
      case 0: {
        const { id, reason } = result.bindings;
        yield* handle_child_exit(state, id, reason);   // helper generator
        break;
      }
      case 1: {
        const pairs = [...state.child_pids.entries()].map(([id, pid]) => [id, pid]);
        yield { type: "send", to: result.bindings.from, msg: ["children_reply", pairs] };
        break;
      }
    }
  }
}
```

`handle_child_exit` is a separate generator function that applies the restart strategy and respawns the appropriate children.

#### AGC codes for supervisors

| Code | Meaning |
|------|---------|
| `AGC-P001` | child exited normally (transient/temporary — no restart) |
| `AGC-P002` | child crashed — restarting (permanent/transient) |
| `AGC-P010` | restart limit exceeded — supervisors exits with "shutdown" |
| `AGC-P020` | restart storm detected (too many restarts in window) |

### 7.2 Registry

Fully described in the [Layer 6 example](#64-writing-a-full-actor--registry-example) above. No additional scaffolding needed.

An enhanced registry that supports supervision-tree notifications adds:

```ts
{ op: "monitor", args: [bind("name"), bind("watcher")] }
```

When a registered name is unregistered, the registry sends `["monitor_down", name]` to all watchers.

### 7.3 Router (round-robin)

A router must forward arbitrary messages it does not recognise, so it uses unconditional receive (`patterns: []`) and dispatches on the tag manually:

```ts
function* round_robin_router_fn(init_args: { workers: Pid[] }): Generator {
  const workers = [...init_args.workers];
  let cursor = 0;

  while (true) {
    // Accept any message; control messages are distinguished by tag
    const result: ReceiveResult = yield { type: "receive", patterns: [] };
    const msg = result.message;
    const tag = msg[0] as string;

    if (tag === "add_worker") {
      workers.push(msg[1] as Pid);
    } else if (tag === "remove_worker") {
      const idx = workers.indexOf(msg[1] as Pid);
      if (idx !== -1) workers.splice(idx, 1);
    } else {
      // Forward any other message round-robin to a worker
      if (workers.length > 0) {
        const target = workers[cursor % workers.length];
        cursor++;
        yield { type: "send", to: target, msg };
      }
    }
  }
}
```

### 7.4 Behaviors

Behaviors are **plain higher-order functions** that return a configured generator function. No macro expansion. The behavior function captures state and returns an actor generator.

#### `server` behavior

A `server` behavior manages a request/reply loop with internal state:

```ts
function make_server<S>(opts: {
  init:       () => S;
  handle_call: (state: S, from: Pid, req: Message) => { reply: Message; next_state: S };
  handle_cast: (state: S, msg: Message) => S;
}): GeneratorFunction {
  return function* server_gen(_args: any[]): Generator {
    let state = opts.init();
    while (true) {
      const result: ReceiveResult = yield {
        type:     "receive",
        patterns: [
          { op: "call", args: [bind("from"), bind("req")] },
          { op: "cast", args: [bind("msg")] }
        ]
      };
      switch (result.index) {
        case 0: {
          const { reply, next_state } = opts.handle_call(
            state,
            result.bindings.from,
            result.bindings.req
          );
          state = next_state;
          yield { type: "send", to: result.bindings.from, msg: reply };
          break;
        }
        case 1: {
          state = opts.handle_cast(state, result.bindings.msg);
          break;
        }
      }
    }
  };
}
```

Usage:

```ts
const counter_gen = make_server<number>({
  init: () => 0,
  handle_call: (state, from, req) => {
    if (req[0] === "get") return { reply: ["count", state], next_state: state };
    return { reply: ["error", "unknown"], next_state: state };
  },
  handle_cast: (state, msg) => {
    if (msg[0] === "inc") return state + 1;
    return state;
  }
});
```

#### `state_machine` behavior

A `state_machine` behavior routes incoming messages to the handler function for the current state:

```ts
type StateHandler<S> = (state: S, msg: Message) => { next: string; state: S } | { done: true };

function make_state_machine<S>(opts: {
  initial:   string;
  init:      () => S;
  states:    Record<string, StateHandler<S>>;
}): GeneratorFunction {
  return function* fsm_gen(_args: any[]): Generator {
    let state_name = opts.initial;
    let state      = opts.init();

    while (true) {
      const result: ReceiveResult = yield { type: "receive", patterns: [] };
      const msg = result.message;
      const handler = opts.states[state_name];
      if (!handler) break;   // undefined state — crash
      const outcome = handler(state, msg);
      if ("done" in outcome) break;
      state_name = outcome.next;
      state      = outcome.state;
    }
  };
}
```

### 7.5 ETS-lite (table actor)

An ETS-lite actor owns a `Map` and handles messages:

```
["get",      key, from_pid]
["put",      key, value]
["delete",   key]
["snapshot", from_pid]
```

```ts
function* ets_fn(_args: any[]): Generator {
  const table = new Map<string, any>();

  while (true) {
    const result: ReceiveResult = yield {
      type:     "receive",
      patterns: [
        { op: "get",      args: [bind("key"), bind("from")] },
        { op: "put",      args: [bind("key"), bind("value")] },
        { op: "delete",   args: [bind("key")] },
        { op: "snapshot", args: [bind("from")] }
      ]
    };

    switch (result.index) {
      case 0: {
        const val = table.get(result.bindings.key) ?? null;
        yield { type: "send", to: result.bindings.from, msg: ["get_reply", result.bindings.key, val] };
        break;
      }
      case 1: {
        table.set(result.bindings.key, result.bindings.value);
        break;
      }
      case 2: {
        table.delete(result.bindings.key);
        break;
      }
      case 3: {
        const snapshot = Object.fromEntries(table);
        yield { type: "send", to: result.bindings.from, msg: ["snapshot_reply", snapshot] };
        break;
      }
    }
  }
}
```

### 7.6 Hot-swap

Hot-swap is achieved through the registry + indirection pattern. No macro needed.

1. The registry maps a logical name to a pid.
2. Clients always look up the pid from the registry before sending.
3. To hot-swap: spawn the new version with the updated function, register the new pid under the same name, let the old task drain its mailbox and exit normally.

The new version does not need to reload any shared state — state is transferred via a `["handover", state]` message from the old version to the new version before the old version exits.

---

## Test Plan

Tests live in `tests/` and are written in `.t2` files, compiled and run by Vitest.

### Test principles

- Each test creates its own `Scheduler` instance — no shared global state.
- Use `spawn_root` + `run()` for integration tests.
- For unit tests of `matchPattern`, call it directly (no scheduler needed).
- Use `send_external` to inject messages from test bodies.

### Test cases

| Category | Test | Description |
|----------|------|-------------|
| matchPattern | exact match | `["ping"]` matches `["ping"]` → `{}` |
| matchPattern | literal mismatch | `["pong"]` vs `["ping"]` → `null` |
| matchPattern | arity mismatch | `["a", "b"]` vs `["a"]` → `null` |
| matchPattern | bind slots | `{op:"register", args:[bind("n"),bind("p")]}` vs `["register","alice",42]` → `{n:"alice", p:42}` |
| matchPattern | literal slot | `{op:"event", args:[lit("click"),bind("x")]}` vs `["event","click",5]` → `{x:5}` |
| matchPattern | literal mismatch | `{op:"event", args:[lit("click"),bind("x")]}` vs `["event","keydown",5]` → `null` |
| matchPattern | wildcard | `{op:"log", args:[_,bind("msg")]}` vs `["log","INFO","hello"]` → `{msg:"hello"}` |
| Task | creation | task starts with status "runnable" |
| Scheduler | spawn | spawned task appears in tasks map |
| Scheduler | send+receive | ping/pong between two actors |
| Scheduler | selective receive | actor skips non-matching messages, accepts matching one |
| Scheduler | mailbox overflow | AGC-M010 emitted when limit exceeded |
| Scheduler | dead pid send | AGC-M050 emitted |
| Registry | register+whereis | register then whereis returns correct pid |
| Registry | unregister | whereis after unregister returns null |
| Supervisor | one_for_one restart | crashed child is restarted, other children unaffected |
| Supervisor | restart limit | AGC-P010 emitted after max_restarts exceeded |
| Server behavior | call | returns correct reply and updates state |
| ETS-lite | put+get | stores and retrieves values |

### Test file structure

```
tests/
  match_pattern.test.t2    # Layer 5 unit tests
  scheduler.test.t2        # Layer 2-4 integration tests
  selective_receive.test.t2
  registry.test.t2
  supervisor.test.t2
  behaviors.test.t2
```

---

## AGC Code Reference

| Code | Severity | Layer | Trigger |
|------|----------|-------|---------|
| `AGC-M010` | warn | Scheduler | Mailbox at capacity — message dropped |
| `AGC-M020` | warn | Scheduler | Mailbox at 80% capacity — slow consumer |
| `AGC-M050` | warn | Scheduler | Send to dead/unknown pid |
| `AGC-S100` | warn | Scheduler | Runnable task count above overload threshold |
| `AGC-S999` | error | Scheduler | Unknown primitive type yielded by actor |
| `AGC-CAP500` | error | Runtime | Actor attempted effect without required capability |
| `AGC-CAP510` | error | Runtime | Actor attempted to forge a capability |
| `AGC-E001` | error | Runtime | Effect dispatch produced an exception |
| `AGC-E050` | warn | Runtime | Effect ran longer than 100ms |
| `AGC-P001` | info | Supervisor | Child exited normally (no restart needed) |
| `AGC-P002` | warn | Supervisor | Child crashed — restarting |
| `AGC-P010` | error | Supervisor | Restart limit exceeded — supervisor terminating |
| `AGC-P020` | error | Supervisor | Restart storm detected |

---

## Appendix: Why Not Macros

For reference, here is a brief summary of why the macro approach was abandoned and why this OO design is strictly better:

| Concern | Macro approach | OO approach |
|---------|---------------|-------------|
| Variable extraction | Required macro-time AST walk — often wrong | Explicit `result.bindings.name` — always correct |
| Binding keys | `Symbol.for("name")` — fragile, non-serialisable | Plain strings — JSON-safe, inspectable |
| Debuggability | Expanded code is invisible | All code is exactly what you wrote |
| Composability | Macros don't compose with each other cleanly | Functions and objects compose freely |
| Parser fragility | Nested `lambda`/`let*` in `defmacro` causes parse errors | No macro parser involved |
| Type checking | Macro output is opaque to the type checker | TypeScript can check the full receive result type |

The OO design has no hidden expansion step. What you yield is what the scheduler receives. What the scheduler returns is what your variable holds. That is the whole model.
