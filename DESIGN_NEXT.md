## A Plan for Verse-Inspired Effect Markers and Containerization in t2agc

This plan assumes v1 is complete — meaning: the scheduler is correct, pattern-matching receive is wired, crash-as-value exists, basic supervision (link/monitor) works, and the execution log exists. That's the foundation everything below builds on.

The plan has three distinct tracks that can advance somewhat independently, then converge:

1. **Effect markers** — annotations baked into t2lang and the runtime
2. **Capability discipline** — enforcing what actors can reach
3. **Containerization** — what SES/Hardened JS can and can't give you, and how to get there

---

## Track 1: Verse-Inspired Effect Markers

### What Verse actually does that's relevant

Verse uses effect types as first-class categories — a function's type signature includes its effects, and the typechecker enforces compatibility. You can't call an effectful function from a pure context without the type system complaining. This is structural, not advisory.

t2agc can't have the full Verse type system. But it *can* have the meaningful parts: **annotations at the t2lang level that Dlite can reason about**, plus **runtime metadata** that makes the annotations inspectable and partially enforceable.

### Step 1: Effect categories in the t2lang surface syntax

Add four effect categories as first-class syntax in t2lang:

```t2
;; Pure: no I/O, no mutation of anything outside the function's local scope,
;; no async. Should be referentially transparent.
(defn :pure add-one ((n : number)) : number
  (+ n 1))

;; State: may mutate actor-local state only (the actor's own state value).
;; No I/O, no sending, no spawning.
(defn :state update-count ((state : CounterState) (delta : number)) : CounterState
  (merge state (object (count (+ (. state count) delta)))))

;; Async: may use await/yield, but only over capabilities passed in explicitly.
;; No ambient I/O.
(defn :async fetch-user ((id : string) (http : HttpCap)) : UserRecord
  (await (method-call http "get" (str-concat "/users/" id))))

;; IO: full capability-based I/O access. The "outer boundary" effect.
(defn :io handle-message ((msg : Message) (caps : ActorCaps)) : void
  (send (. msg reply_to) (array "result" (await (fetch-user (. msg user_id) (. caps http))))))
```

The key design decisions here:

- `:pure` and `:state` are subsets of `:async`, which is a subset of `:io`. This is a partial order, not four independent categories. Dlite enforces the ordering: a `:pure` function may only call other `:pure` functions; a `:state` function may call `:pure` or `:state`; and so on.
- The annotation is on the *definition*, not the call site. Call sites are checked by Dlite against the callee's declared effect.
- Unlabeled functions default to `:io` (the most permissive). This is the conservative choice — you opt *down* toward purity, you don't opt up toward impurity.

### Step 2: Dlite effect analysis

This is the right home for effect checking, not the runtime. Dlite already has a message flow graph and behavior analysis infrastructure. Add:

**Effect graph**: for each function/behavior, record its declared effect and the effects of everything it calls. Dlite then checks:
- Does this `:pure` function call anything that isn't `:pure`? → `AGC-EFF100` (purity violation)
- Does this `:state` function use a capability? → `AGC-EFF110` (capability leak into state handler)
- Does this `:io` actor behavior call `:pure` helper functions? Fine. The reverse isn't.

**Behavior-level annotation**: actor behaviors get an effect declaration too:

```t2
(behavior :state counter-behavior
  (handle (:inc n) (state caps)
    (:state (update-count state n)))
  (handle (:get from) (state caps)
    (:io (send from (array "reply" (. state count)))))
  (handle (:stop) (state caps)
    (:state state))) ;; pure return, no effect
```

Each handler clause declares its effect. Dlite can verify consistency: a behavior declared `:state` shouldn't have handlers that do `:io` without an explicit escalation annotation.

### Step 3: Runtime metadata (lightweight)

The runtime doesn't need to *enforce* effects — Dlite handles that. But it should carry them as inspectable metadata, for tooling, logging, and the execution log:

```ts
// When t2lang compiles a :pure function, it emits:
markEffect(fn, "pure");

// The execution log records effect category per step:
{ time, actorRef, kind: "message-handled", effectCategory: "state", ... }
```

This makes the execution log richer — you can see at a glance that a given message handler did state-only work vs. one that did I/O.

### Step 4: Pure-first design pattern for behaviors

The practical benefit of effect markers is a design pattern: **push as much logic as possible into `:pure` or `:state` functions, and keep `:io` handlers thin**. Dlite can enforce this with an optional lint rule:

`AGC-EFF200` — an `:io` handler does more than 5 lines of non-capability logic (configurable threshold). Hint: extract the logic into a `:pure` or `:state` helper.

This is the Verse-inspired discipline: effects are explicit at the boundaries, and pure logic dominates the interior. You get this without a full dependent type system.

---

## Track 2: Capability Discipline (Runtime-Level)

### The current state

`CapabilitySpec` exists in `types.t2`. `spawn` accepts a `caps` argument. But it's a `Set` and is never consulted.

### Step 1: Typed capability objects

Replace the untyped `Set` with a first-class capability record:

```ts
interface ActorCaps {
  http?: HttpCapability;
  storage?: StorageCapability;
  clock?: ClockCapability;
  io?: GenericIOCapability;
  // ... extensible
}
```

`spawn(behavior, initialState, caps: ActorCaps)` — the caps object is the only way for an actor to reach external resources. The runtime passes it to the behavior on each message dispatch.

### Step 2: Runtime capability checks

At message dispatch time, the runtime can do a cheap check: does this handler declare `:io` effect but have no capabilities in its caps object? If so, it can't legitimately do I/O — log `AGC-EFF300` (declared I/O effect but no capabilities).

This is partial enforcement — it catches the case where you forgot to pass caps — but it doesn't prevent a clever actor from escaping through ambient globals. That's where containerization enters.

### Step 3: Capability inheritance in spawn

When actor A spawns actor B, B's capabilities should be a *subset* of A's:

```t2
;; A has http + storage. It spawns B with only http.
(spawn worker-behavior initial-state (select-caps parent-caps [:http]))
```

Dlite can check this statically. The runtime can check it at spawn time and emit `AGC-CAP100` if a child is spawned with capabilities the parent doesn't have.

---

## Track 3: Containerization — What SES/Hardened JS Actually Offers

Now for the honest assessment of SES and Hardened JS.

### What SES actually is

**Hardened JS** (the broader project, maintained by Agoric/Endo) has two layers:

**`lockdown()`** — called once at JS startup, it:
- Freezes all intrinsics (`Object.prototype`, `Array.prototype`, etc.)
- Removes `eval`, `Function` constructor, and other obvious escape hatches
- Makes the JS environment "safe to share" — multiple pieces of code can run in the same realm without being able to mutate shared prototype methods

**`Compartment`** — a separate "virtual realm":
- Has its own set of module globals
- Import resolution is intercepted (you control what `import 'foo'` resolves to)
- Code inside a compartment can't see the outer realm's globals unless explicitly endowed
- But it *shares the frozen intrinsics* with the parent realm — it's not a separate V8 context, it's a lexically isolated module environment

Both are **production-grade and well-maintained**. The Agoric smart contract platform runs real financial logic in SES compartments. The Endo project has extensive test coverage. This is not experimental — it's hardened and used in production.

### What SES gives you for free

Once `lockdown()` is called:
- No actor can do `Array.prototype.push = evilFn` and affect other actors
- No actor can use `eval` or `new Function(...)` to bypass effect discipline
- Prototype mutation attacks (a real JS concern) are neutralized
- `Object.freeze` and `harden()` (deep freeze + mark as hardened) are available

`harden()` is particularly useful: you can harden a capability object before passing it to an actor, making it structurally immutable. The actor can call the capability's methods but can't replace them.

### What SES does *not* give you

This is the critical thing to understand:

**SES compartments do not isolate closures.** A `Compartment` is a module environment — it controls what you can `import`, and what globals are visible at module evaluation time. But a generator function (t2agc's actor model) is a *live closure*, not a module. If you create a generator function in the outer realm and hand it to a compartment, the generator retains its closure over the outer realm. The compartment boundary doesn't apply to it.

**SES compartments are for loading code strings**, not wrapping live objects. The idiomatic use is:

```js
const c = new Compartment({ globals_you_want_to_expose });
c.evaluate(`(function() { /* actor code here */ })`);
// or
c.import('./actor-module.js'); // intercepted by your module loader
```

This means: **SES compartments are a t2lang compilation target concern, not a t2agc runtime concern** — at least if you want real isolation.

### The realistic path to SES isolation

Here's what would actually have to be true for t2agc actors to run in SES compartments with real isolation:

**t2lang must emit actors as loadable module strings.** The t2lang compiler, instead of (or in addition to) emitting TypeScript/JS source files for static bundling, emits actor behaviors as self-contained module strings that can be loaded via `c.import()`. This is a compiler feature.

The module format for a behavior would look like:

```js
// emitted by t2lang for a :state counter behavior
export function makeCounterBehavior(capabilities) {
  return function* counterBehavior(initialState) {
    let state = initialState;
    while (true) {
      const msg = yield { type: "receive", patterns: counterPatterns };
      if (msg[0] === "inc") {
        state = { ...state, count: state.count + msg[1] };
      } else if (msg[0] === "get") {
        capabilities.send(msg[1], ["reply", state.count]);
      }
    }
  };
}
```

This module is evaluated inside a compartment, with a controlled `capabilities` endowment that does *not* include `fetch`, `fs`, `process`, etc. unless explicitly passed. The compartment's module loader intercepts any `import` attempts. The generator function is created *inside* the compartment, so its closure is over compartment-scope, not outer-realm scope.

**This is achievable, but requires the t2lang compiler to target this format deliberately.**

### Phased plan for containerization

**Phase C1: `lockdown()` at runtime startup (low effort, immediate benefit)**

Call `lockdown()` once when `init_runtime()` is called. This:
- Freezes intrinsics system-wide
- Enables `harden()` use throughout the codebase
- Doesn't require compartments yet
- Costs: you can no longer mutate `Array.prototype` etc. anywhere — but t2agc shouldn't be doing that anyway

All capability objects should then be passed through `harden()` before being given to actors:
```ts
const caps = harden({ http: httpCap, clock: clockCap });
spawn(behavior, state, caps);
```

This is a real, immediately meaningful isolation step. A misbehaving actor cannot corrupt the capability objects it receives.

**Phase C2: Harden actor state snapshots**

When the execution log takes a state snapshot (for replay/debugging), `harden()` the snapshot. This guarantees that the logged snapshot can't be mutated after the fact, making log replay reliable.

**Phase C3: t2lang emits compartment-loadable behavior modules**

This is where the compiler gets involved. t2lang adds a compilation mode that emits actor behaviors as compartment-loadable module strings. The runtime gains a `createActorCompartment(moduleSource, endowments)` function that:

1. Creates a new `Compartment` with a custom module loader that whitelists only the t2agc runtime primitives (`send`, `receive`, `self`, `after`) and the passed `endowments` (capabilities)
2. Evaluates the behavior module source inside the compartment
3. The resulting generator function is genuinely isolated — its closure contains only what the compartment allowed

The key design constraint: **the compartment's module loader must be the gating mechanism**. Any `import 'node:fs'` or `import 'fetch'` attempted from inside a behavior module hits the interceptor and is denied unless it's in the whitelist.

**Phase C4: Verified `:pure` functions via the compartment model**

Here's where the Verse-inspired effect markers and compartments converge in an interesting way:

A `:pure` function, in the t2lang compilation model, can be emitted into a *maximally restricted compartment*:
- No capabilities endowed (empty endowments)
- No `send`, `receive`, or any runtime primitive in scope
- Only math, string operations, and other `:pure` functions
- `harden()`-ed before use

When the runtime tries to call a `:pure` function that was compiled in this mode, it can guarantee: this function has no path to I/O. It can't send a message. It can't touch a capability. Not because we inspected the source, but because the compartment's environment simply doesn't contain those things.

This is **"pure enough" in a meaningful sense** — not proven pure by type theory, but isolated pure by construction. The distinction matters: you don't need a type system to make strong guarantees here, you need a capability-safe runtime.

For `:state` functions, the compartment is endowed with one extra thing: a mutable reference to the actor's own state — but nothing else. This is the Verse `state` effect implemented as a compartment constraint.

---

## How the Three Tracks Converge

The full picture, once all three tracks are complete:

```
t2lang source
    │
    ├── Dlite checks effect annotations statically
    │   (AGC-EFF* codes for violations)
    │
    └── Compiler emits behavior modules per effect category:
        │
        ├── :pure behaviors → maximally restricted compartment (no endowments)
        ├── :state behaviors → compartment with state-ref only
        ├── :async behaviors → compartment with async primitives + named caps
        └── :io behaviors → compartment with full capability set

t2agc runtime
    │
    ├── lockdown() on init (freezes intrinsics)
    ├── harden() on all capability objects
    ├── Compartment per actor (Phase C3+)
    ├── Capability inheritance enforced at spawn
    └── Execution log records effect category per step
```

At this point you have:
- Verse-style effect categories as a first-class concept, statically checked
- Capability discipline at the runtime level
- "Pure enough" functions enforced by the runtime environment, not just by convention
- All of it built on production-grade, maintained infrastructure (Hardened JS)

---

## Realistic Assessment of Effort and Risks

**Effect markers + Dlite analysis**: Medium effort. This is mostly a t2lang parser and Dlite extension. The runtime metadata is a few lines. The real work is defining the effect compatibility rules carefully enough that Dlite's error messages are actionable.

**Capability discipline in the runtime**: Low-to-medium effort. The types already exist. The main work is wiring `spawn` to actually use the caps object and enforcing inheritance.

**`lockdown()` + `harden()`**: Low effort. One call at init, one call per capability object construction. The main risk is that existing test infrastructure or tooling (Vitest, ts-node wrappers) breaks under `lockdown()` because they mutate intrinsics. This is a known issue with SES adoption — you may need to call `lockdown()` after test harness setup, or use Endo's `@endo/init` which handles this.

**Compartment-loadable behavior modules**: High effort. This requires a deliberate t2lang compilation target. The compiler needs to emit self-contained module strings (not just `.t2` → `.ts` → bundle), handle the module loader interception, and the runtime needs compartment lifecycle management. This is the longest-lead-time item and arguably the most architecturally significant decision in the whole plan.

**The order matters**: `lockdown()` first (C1), because everything that comes after assumes frozen intrinsics. Effect markers second (Track 1), because they inform the compartment structure (Track 3). Capability discipline (Track 2) can proceed in parallel with effect markers. Compartment-loadable modules (C3/C4) last, after the compiler target question is resolved.
