# BeOS, Haiku, and Mach: Lessons for t2agc

**Status:** Reference and planning document
**Scope:** Concepts worth understanding, mapped to concrete t2agc work
**Not:** A redesign proposal or a replacement for fixing v1

---

## Why these systems are relevant

t2agc is building an actor runtime with cooperative scheduling, capability-mediated effects, and structured message passing. Three historical systems solved adjacent problems at a deeper level than Erlang did, and their solutions contain useful ideas — not as things to copy wholesale, but as prior art that sharpens design decisions t2agc will have to make anyway.

**BeOS and Haiku** built message passing as a universal system interface, not just a concurrency primitive. Everything — windows, applications, hardware input, inter-process communication — was expressed as messages to named endpoints. The lessons are about ergonomics and observability: what happens when you commit fully to the message-passing model at every layer of a system.

**Mach** (the microkernel underlying macOS, iOS, and others) built capability-based IPC as the foundation of OS security and resource management. A Mach port is simultaneously a communication channel, an unforgeable capability, and a schedulable resource. The lessons are about security and resource discipline: what it means for capabilities to be first-class objects rather than conventions.

These are not exotic or academic references. Mach ports are what macOS uses for inter-process communication today. Haiku is an actively maintained OS. The ideas are proven and the tradeoffs are well-documented.

---

## What each system teaches

### From BeOS and Haiku: Mailboxes as observable, bounded system resources

BeOS had **ports** — kernel-managed message queues with a fixed capacity, a name, a priority, and visibility to system tools. You could inspect any port's queue depth, see who was sending to it, and observe backpressure in real time. Overflow was not silent: the sending thread would block or get an error, depending on how the call was made. Ports were first-class objects, not implementation details.

The contrast with t2agc's current mailbox is stark. Today `MessageQueue` is a ring buffer with hardcoded capacity 100 that silently drops the oldest message on overflow, emits no diagnostic, and is invisible to any external tool. The `__t2agc__` inspector described in DESIGN.md doesn't exist yet.

The BeOS lesson is not about copying the port API. It is about the **design commitment**: if mailboxes are first-class objects, they become the natural unit of observability, backpressure, and resource accounting. Naming an actor's mailbox, making its depth visible, and making overflow a policy decision (rather than a silent drop) turns a debugging problem into a monitoring feature.

**What this means concretely for t2agc:**
- Mailbox overflow should be a configurable policy per actor: drop-oldest (current, but make it visible), drop-newest, backpressure (block the sender), or crash-the-receiver
- Overflow events should emit AGC diagnostic codes
- The `__t2agc__` inspector should expose per-actor mailbox depth, high-water marks, and drop counts
- Mailbox capacity should be settable at spawn time (the `mailbox_limit?` field already exists in `SpawnPrimitive` but is not wired up)

BeOS also committed to **typed, structured messages** as the universal interface. A `BMessage` had typed fields with string keys, not an opaque binary blob. You could introspect a message without knowing what produced it. This is the direction t2agc's `defprotocol` and `IPattern` system is already heading — BeOS validates that this commitment is worth making fully and not just partially.

### From Mach: Ports as capabilities, not just addresses

In Mach, a port is not just an address you send messages to. It is an **unforgeable capability** — a right to communicate with a particular endpoint. You cannot guess a port name; you must be given it. You cannot hold a send right without someone explicitly granting it to you. Dropping your last reference to a port right is how you revoke access. The kernel enforces all of this; no cooperation from userspace is required.

The consequence is that Mach IPC is capability-based by construction, not by convention. You do not need to trust that code will follow the rules — the rules are structurally enforced by what references the code possesses.

t2agc's capability system is currently convention-based. `caps` is passed at spawn time, but a misbehaving actor could close over ambient globals, call `fetch`, or reach through `process.env` without touching its caps object at all. The SES/Hardened JS track in the containerization plan is t2agc's path toward making this structural rather than conventional — `lockdown()` removes the ambient escape hatches, and compartments control what a behavior module can see at evaluation time.

The Mach lesson reinforces this direction and adds one specific insight: **capability revocation should be a first-class operation, not just a spawn-time decision**. In Mach, you can send a capability to another process, and that process can hold it, use it, and pass it further. The original holder can't revoke it unilaterally once sent — this is a known Mach limitation that Mach successor systems (like EROS and later seL4) addressed. For t2agc, the practical implication is: think carefully about whether capabilities can be forwarded between actors, and if so, how revocation works. This is a design question that needs an answer before the capability system is fully built.

Mach also pioneered **out-of-line memory in messages** — large data payloads that are remapped rather than copied, so the receiver gets a reference to the same physical pages without a memcpy. In JS there is no equivalent, but the principle translates: for large shared data, pass a `harden()`-ed frozen object reference rather than cloning. The receiver gets read-only access to the same data. This is not zero-copy in the Mach sense, but it is the closest JS analogue and it is already consistent with the Hardened JS plan.

**What this means concretely for t2agc:**
- `ActorRef` (a pid) should be thought of as a capability, not just an address — you need to *hold* a ref to send to an actor
- The question of whether capabilities can be forwarded in messages (`send(other_pid, { caps: my_http_cap })`) needs a deliberate answer
- Large shared data should be passed as `harden()`-ed objects, not cloned
- The SES/compartment track is the right path to making capability discipline structural

### From Haiku specifically: Named, routable message endpoints

Haiku (the open-source BeOS successor) added a **roster** — a system-wide registry of running applications and their message ports. Applications could find each other by name, register well-known services, and publish message schemas. This is Haiku's global registry, which the original synthesis document correctly flagged as something to avoid copying directly. Global mutable registries are antithetical to capability discipline.

But there is a narrower, useful insight: **well-known service endpoints should be first-class, named, and discoverable within a defined scope**. Not globally, but within a supervisor tree or an application-level scope. The OTP equivalent is `Registry` and named processes. The t2agc equivalent would be a scoped name service — an actor that holds a mapping from names to refs, passed as a capability at spawn time. You can discover services within your scope without needing ambient global access.

This is a library-level concern, not a kernel concern. It belongs in the OTP layer, not in the core runtime.

---

## What not to carry over

**Mach's synchronous RPC as the primary communication pattern.** Mach `mach_msg` supports both async send and synchronous request/reply. In practice, macOS systems overuse the synchronous form, which introduces the possibility of priority inversion and deadlock in ways that async messaging avoids. t2agc should stay async-message-first. The `call(actor, msg, timeout)` / `reply(token, msg)` pattern (Erlang's GenServer `call`) is fine as a library abstraction built on async messages, but it should not be a runtime primitive.

**BeOS's thread-per-actor model.** BeOS gave every Looper (an actor-like object) its own OS thread. This was ergonomic but expensive. t2agc's cooperative, generator-based scheduler is the right model for JS — many actors, one thread, explicit yield points. The BeOS lesson is about message-passing ergonomics, not threading model.

**Haiku's global application roster.** A system-wide mutable registry of all running actors is a capability discipline violation. Service discovery should be scoped and capability-mediated, not ambient.

**Mach's complexity as a virtue.** Mach IPC is famously complicated and has known performance issues that macOS has had to paper over with special cases. t2agc should borrow Mach's *principles* (capability ports, structural enforcement, revocation) without borrowing its complexity.

---

## High-level plan: applying these lessons in t2agc

These map onto the existing work phases, not as new phases but as refinements to decisions that will be made anyway.

### During v1 completion

**Fix mailbox overflow to be observable (BeOS lesson)**

The silent ring-buffer drop needs to become an observable policy. The minimum change: emit an `AGCEvent` with a new code (e.g. `AGC-MBX100`) when a message is dropped. The better change: add `overflow_policy` as a spawn-time option (`"drop-oldest" | "drop-newest" | "crash"`), default to `"drop-oldest"` for backward compatibility, and always emit the diagnostic. Wire up `mailbox_limit?` from `SpawnPrimitive`.

**Name the supervision tree concept "team" (BeOS lesson)**

The unit of restart in the supervisor design — a group of actors that fail and restart together — should be called a **team** throughout the codebase and documentation. This aligns with BeOS/Haiku terminology and gives a precise name to a concept that is currently implicit. A team has a supervisor, a set of member actors, and a restart policy. Team boundaries are also capability boundaries: actors in a team share capabilities granted to the team at creation time.

### During the capability discipline phase (post-v1)

**`ActorRef` as an explicit capability (Mach lesson)**

When the capability system is being built out, the design should treat `ActorRef` (pid) as a held capability, not just a number. In practice this means: an actor should only be able to `send` to refs it has been given — either its parent gave it the ref at spawn, it received the ref in a message, or it spawned the target itself. Refs should not be guessable integers. This is a breaking change from the current `Pid = number` design, so it needs to be decided deliberately during the capability phase rather than retrofitted later.

The concrete representation could stay as an integer internally for scheduling efficiency, but the *interface* exposed to actors should be an opaque `ActorRef` object that cannot be constructed from an integer. This is the Mach "unforgeable port name" principle in JS terms.

**Deliberate decision on capability forwarding (Mach lesson)**

Before the capability system is finalized, decide: can an actor forward a capability it holds to another actor in a message? Three options, each with tradeoffs:

- *No forwarding* — capabilities are spawn-time only. Simple, restrictive.
- *Forwarding but no revocation* — an actor can pass capabilities to others. Flexible, but once a capability escapes, the original holder can't take it back. This is Mach's limitation.
- *Attenuated forwarding* — an actor can create a restricted version of a capability it holds (e.g., a read-only view of a storage capability) and forward that. More complex but more principled. This is the object-capability literature's standard answer.

The right choice for t2agc is probably attenuated forwarding, since it fits the Verse-style effect hierarchy (`:io` can attenuate to `:async`, etc.), but this needs to be a conscious design decision with documentation, not something that falls out of implementation choices.

**Scoped name service in the OTP layer (Haiku lesson)**

As part of building out the OTP layer, add a `NameService` actor — a simple actor that maps string names to `ActorRef`s, passed as a capability to actors that need service discovery. This is not a global registry; it is a scoped one. Different supervisor trees can have different name services. An actor without a `NameService` capability in its caps cannot do service discovery at all. This is the Haiku roster made capability-safe.

### During the SES/containerization phase (post-capability discipline)

**Large message payloads as `harden()`-ed references (Mach lesson)**

Establish a convention: when an actor sends a message containing a large data object (above some threshold, or for specific payload types), the sender should call `harden()` on the payload before sending. The receiver gets an immutable reference. This avoids both the cost of deep cloning and the hazard of shared mutable state. Document this as t2agc's analogue of Mach out-of-line memory.

**`__t2agc__` inspector with per-actor mailbox metrics (BeOS lesson)**

When the execution log is built, the inspector should expose BeOS port-style metrics per actor: current mailbox depth, capacity, high-water mark, drop count by policy, and message throughput. This turns the mailbox from an implementation detail into an observable, manageable resource. Systems operators (or agent-assisted debuggers) can identify backpressure, dropped messages, and overloaded actors without reading source code.

---

## Summary

The practical contributions from studying these systems are modest in scope but high in precision:

| Lesson | Source | Where it applies in t2agc |
|--------|--------|---------------------------|
| Mailboxes as named, bounded, observable resources | BeOS | v1 mailbox fix + `__t2agc__` inspector |
| Overflow as configurable policy, not silent drop | BeOS | v1 mailbox fix |
| "Team" as the named unit of supervised restart | BeOS | Supervision design terminology + capability scoping |
| Scoped name service (not global registry) | Haiku | OTP layer `NameService` actor |
| ActorRef as unforgeable capability, not a guessable integer | Mach | Capability discipline phase |
| Deliberate decision on capability forwarding and attenuation | Mach | Capability discipline phase |
| Large shared payloads via `harden()`-ed references | Mach | SES/containerization phase |
| Avoid synchronous RPC as a runtime primitive | Mach (anti-pattern) | GenServer stays library-level |

None of these require new phases of work. They are refinements to decisions already in the plan, informed by systems that faced the same design pressures and documented the consequences.
