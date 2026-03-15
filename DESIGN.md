# **t2‑agc: Core Design Document (Canonical Edition)**  
### *A tiny, deterministic, actor‑style execution model inspired by the Apollo Guidance Computer*

---

# 1. Overview

t2‑agc is a **small, deterministic, cooperative concurrency runtime** designed for t2‑lang.  
It models:

- **tasks** (lightweight processes)  
- **mailboxes**  
- **selective receive**  
- **explicit yields**  
- **capability‑based effects**  
- **bounded work**  
- **AGC‑style diagnostics**  

It is intentionally:

- tiny  
- explicit  
- predictable  
- debuggable  
- inspectable via a global `__t2agc__` object  

Higher‑level layers (t2‑agc‑otp, Dlite) build on this foundation.

---

# 2. Execution Model

### 2.1 Tasks  
A task is a cooperative, generator‑based execution unit with:

- its own mailbox  
- its own reduction budget  
- its own priority  
- its own effect capabilities  

Tasks run until:

- they yield  
- they block on `receive`  
- they exhaust their reduction budget  
- they terminate  

**t2-lang Example:**
```t2
(task my-worker (initial-state cap-log)
  (:priority :normal)
  (let (state initial-state)
    (loop
      (let (msg (receive))
        (effect cap-log :info "Got message")
        (yield)
        (recur)))))
```

### 2.2 Scheduler  
The scheduler:
- knows about **every** task.
- runs tasks in priority buckets.
- removes tasks from the run queue when they block on `receive`.
- re-queues them dynamically when a matching message arrives via `send`.
- enforces reduction budgets.
- handles overload.
- emits AGC‑coded warnings.
- maintains system‑level histories.  

### 2.3 Determinism  
t2‑agc is deterministic *given the same message order*.  
Selective receive introduces controlled nondeterminism, but only within the mailbox of a single task.

---

# 3. Core Concepts

## 3.1 Messages  
Messages are **tagged tuples**:

```t2
'(:tag arg1 arg2 ...)
```

They are immutable and pattern‑matchable.

**t2-lang Example:**
```t2
;; Construction
(let (msg '(:user-logged-in "alice" 12345))
  (send logger-pid msg))
```

## 3.2 Mailboxes  
Each task has a private mailbox:

- append‑only on `send`  
- scanned on `receive`  
- supports selective receive  
- supports AGC‑coded warnings for unhandled messages  

**t2-lang Example:**
```t2
(send target-pid '(:ping self))
```

## 3.3 Selective Receive  
Selective receive allows a task to:

- scan its mailbox  
- match messages by pattern  
- remove only the matched message  
- leave unmatched messages in place  

This is a **core runtime semantic**, not an OTP feature.

**t2-lang Example:**
```t2
;; Even if a :low-priority message is first in the mailbox,
;; this receive block prioritizes finding a :high-priority message.
(receive
  ('(:high-priority data) 
    (process data))
  ('(:low-priority data) 
    (process data)))
```

## 3.4 Pattern Matching  
Pattern matching is used in:

- `receive`  
- `match`  
- protocol declarations  
- opaque type matching  

Patterns may include:

- literal values  
- tagged tuples  
- destructuring  
- wildcards  
- guards  

**t2-lang Example:**
```t2
(match msg
  ('(:ok value) (handle-value value))
  ('(:error rsn) (handle-error rsn))
  (_ (log "Unknown message")))
```

## 3.5 Capabilities  
Effects (I/O, timers, shared blobs, etc.) are accessed via **capabilities**.  
Tasks cannot perform effects without explicit capabilities.

**t2-lang Example:**
```t2
(task network-reader (cap-io)
  (let (data (effect cap-io :read "http://example.com"))
    (send parent '(:http-result data))))
```

## 3.6 Histories  
Each task maintains:

- **effects history**  
- **exceptional history**  
- **critical history** (system‑level)  

These are woven into timelines for debugging.

---

# 4. `defprotocol` — Message Protocol Declaration

`defprotocol` defines the **allowed message shapes** for a task or behavior.

### Syntax

```t2
(defprotocol Name
  (pattern1)
  (pattern2)
  ...)
```

### Example

```t2
(defprotocol Counter
  (:inc n)
  (:get from)
  (:reset))
```

### Semantics

- Protocols exist **at runtime** as metadata.  
- Used by selective receive, debugging, and Dlite.  
- Defines tag + arity + argument positions.  
- Helps detect unhandled messages and unreachable clauses.

### IR Representation

```json
{
  "kind": "protocol",
  "name": "Counter",
  "messages": [
    { "tag": ":inc", "arity": 1 },
    { "tag": ":get", "arity": 1 },
    { "tag": ":reset", "arity": 0 }
  ]
}
```

---

# 5. IR (Intermediate Representation)

The IR is a small set of forms representing t2‑lang constructs.

### 5.1 Task creation

```
(task name (args...) body...)
```

### 5.2 Sending messages

```
(send pid msg)
```

### 5.3 Receiving messages (selective receive)

```
(receive
  (pattern1 => body1)
  (pattern2 => body2)
  ...)
```

Expands into a mailbox scan loop.

### 5.4 Effects

```
(effect capability args...)
```

### 5.5 Protocol metadata  
IR nodes carry protocol annotations when applicable.

---

# 6. Kernel (JS Runtime)

The kernel is a small JS module implementing:

- task creation  
- mailbox management  
- selective receive  
- scheduling  
- effect dispatch  
- logging  
- AGC‑coded diagnostics  

## 6.1 Mailbox Structure

```js
task.mailbox = [];
task.mailboxConfig = {
  maxMailbox: 1000, // example limit
  onOverflow: ":drop-oldest"
};
```

Every task defines core-level mailbox semantics:
- `:max-mailbox N`
- `:on-overflow POLICY`

Where `POLICY` is one of:
- `:drop-oldest` (default) - Drop the oldest message in the mailbox. Safest for a JS-based actor system.
- `:drop-newest` - Reject the incoming message.
- `:reject` - Sender gets an error message.
- `:escalate` - Crash the task (supervisor restarts it).
- `:block-sender` - (optional) sender yields until space available.

**t2-lang Example:**
```t2
(task high-throughput-worker ()
  (:max-mailbox 5000)
  (:on-overflow :reject)
  (loop
    (let (msg (receive))
      ;; ...
      )))
```

## 6.2 Selective Receive Algorithm

All messages go through the kernel.

**On `receive` (Task):**
1. Iterate through mailbox.  
2. For each message:
   - try patterns in order  
   - if match:
     - remove message  
     - return match result  
3. If no match:
   - task suspends and is **removed from the run queue**.
   - runtime remembers the unfulfilled patterns for this task.

**On `send` (Kernel):**
1. Append to the target's mailbox (applying `:max-mailbox` and `:on-overflow` policies).
2. Check if the target is in a waiting state.
3. Check the target's registered receive patterns.
4. If the new message matches, **wake the task** and re-queue it in the scheduler.  

## 6.3 Unhandled Message Warnings

If a message remains unhandled too long:

```
AGC-M030 unhandled message in mailbox
```

---

# 7. Scheduler

### 7.1 Priority Buckets

- `critical`  
- `high`  
- `normal`  
- `low`  
- `idle`  

### 7.2 Reduction Budgets  
Each task gets a fixed number of reductions per slice.

### 7.3 Overload Detection  
Scheduler monitors:

- run queue length  
- slice duration  
- effect latency  

On overload:

- emit `AGC-S100`  
- optionally enter emergency mode  

---

# 8. Capabilities and Effects

Capabilities are explicit objects granting access to effects (I/O, timers, shared blobs, logging, random numbers).
To maintain a strict Actor model, capabilities are **never** held in a global registry. They must be:
- passed explicitly as arguments when a task is spawned (`spawn`).
- sent via messages between tasks.

Tasks cannot perform effects without explicit capabilities.

**t2-lang Example:**
```t2
;; The parent task was given log, io, and timer capabilities.
(task parent (cap-log cap-io cap-timer)
  
  ;; It spawns a child, but intentionally restricts it
  ;; by ONLY passing the timer capability down.
  (let (child (spawn child-task cap-timer))
    (send child '(:start))))

(task child-task (cap-timer)
  (let (msg (receive))
    (match msg
      ('(:start) 
        (effect cap-timer :sleep 1000)
        (print "I can sleep, but I cannot do network I/O!")))))
```

---

# 9. Debugging Architecture

## 9.1 Global Debug Root

A global object:

```js
globalThis.__t2agc__
```

Contains:

- task table  
- scheduler state  
- histories  
- debug helpers  

## 9.2 Debug Helpers

- `listTasks()`  
- `dumpMailbox(id)`  
- `dumpHistory(id)`  
- `weaveTaskHistory(id)`  
- `weaveSystemHistory()`  

## 9.3 Timeline Weaving

Combines:

- task histories  
- system histories  
- effect events  
- receive events  
- AGC codes  

---

# 10. AGC Codes (Diagnostics)

### Message‑level

- `AGC-M010` mailbox overflow  
- `AGC-M020` slow consumer  
- `AGC-M030` unhandled message  
- `AGC-M031` message stuck too long  
- `AGC-M040` excessive mailbox scanning  

### Protocol‑level

- `AGC-PROT210` unhandled protocol message  
- `AGC-PROT220` unreachable receive clause  

### Scheduler‑level

- `AGC-S100` overload detected  

### Effect‑level

- `AGC-E0xx` slow or blocked effect  

---

# 11. Memory Stability

t2‑agc guarantees:

- no unbounded mailbox growth (with policies)  
- bounded reduction per slice  
- bounded effect latency (with warnings)  
- deterministic scheduling  

Selective receive does not violate stability:

- scanning is bounded by reduction budget  
- unmatched messages remain in mailbox  
- warnings emitted for pathological cases  

---

# 12. Summary

t2‑agc provides:

### ✔️ Tasks  
### ✔️ Mailboxes  
### ✔️ Selective receive  
### ✔️ Pattern matching  
### ✔️ Protocols (`defprotocol`)  
### ✔️ Capabilities  
### ✔️ Deterministic scheduling  
### ✔️ AGC‑coded diagnostics  
### ✔️ Global debugging architecture  
### ✔️ IR suitable for analysis (Dlite)  
### ✔️ A tiny, explicit, predictable runtime  

This is the **foundation** on which t2‑agc‑otp and Dlite build.

---

# 13. Addendum: Prioritized mailboxes

Yes — priority‑aware mailbox load shedding is not only feasible, it fits the t2‑agc model perfectly.
It should be:

    in the core (because mailboxes are core)
    configurable per task
    visible in AGC diagnostics
    analyzable by Dlite
    integrated with priority buckets

This gives you a principled, actor‑native way to prevent runaway memory and latency cascades.
🌿 Why this matters

Mailbox overload is one of the most common real‑world failure modes in Erlang systems.
People in the HN thread even call it out:

    “A bad mailbox backlog can turn local slowness into cluster‑wide pain…”

In t2‑agc, where:

    the heap is shared
    GC is global
    tasks are cooperative
    selective receive can scan the whole mailbox

…unbounded or undifferentiated mailboxes are even more dangerous.

So priority‑aware load shedding is a natural fit.
🌳 What priority‑aware load shedding means

Each message has:

    a protocol tag
    a shape
    and (implicitly) a priority category based on the sender’s task priority bucket

We can use that to decide:

    which messages to keep
    which to drop
    which to escalate
    which to reject

This is not Erlang’s model — it’s better suited to a JS runtime.
🌲 Proposed design
1. Each task declares a mailbox policy

Something like:

(task MyServer
  (:max-mailbox 500)
  (:shed-policy :drop-lowest-priority)
  ...)

Policies could include:

    :drop-lowest-priority
    :drop-oldest
    :drop-newest
    :reject
    :escalate
    :block-sender

But the new one is:
:drop-lowest-priority

When mailbox is full:

    drop messages from idle first
    then low
    then normal
    never drop high or critical unless explicitly allowed

This is exactly how real‑time systems behave.
2. Priority is inherited from the sender

If a low‑priority task sends a message to a normal‑priority server, that message is marked low.

This gives you:

    natural backpressure
    fairness
    protection for critical paths

3. AGC‑coded diagnostics

When shedding occurs:

AGC-M050 mailbox shedding: dropped 12 low-priority messages
AGC-M051 mailbox shedding: dropped 1 normal-priority message
AGC-M052 mailbox shedding: critical message dropped (escalation)

These appear in:

    task history
    system history
    woven timelines

This makes overload visible.
4. Dlite static analysis

Dlite can check:
✔️ tasks that receive high‑priority messages but shed them
✔️ tasks that shed messages from protocols that require reliability
✔️ tasks that shed messages but never handle the overflow case
✔️ tasks that have no mailbox policy (COV warning)
✔️ tasks that shed messages from higher‑priority senders (error)

This is incredibly useful.
🌵 Why this fits the t2‑agc philosophy
✔️ Explicit

Developers must declare policies.
✔️ Deterministic

Shedding rules are predictable and reproducible.
✔️ Debuggable

AGC codes + woven timelines show exactly what happened.
✔️ Analyzable

Dlite can reason about mailbox behavior statically.
✔️ Safe

Prevents runaway memory and latency cascades.
✔️ JS‑appropriate

Avoids unbounded heap growth in a shared‑heap environment.
🌞 Final recommendation

Yes — t2‑agc should support priority‑aware mailbox load shedding at the core level.

# 14. Addendum: Protocol mismatch detection

🌟 The core insight

t2‑agc protocols are runtime objects, not compile‑time schemas.
That means versioning must be:

    explicit
    visible
    analyzable
    checkable
    and not dependent on codegen or schema registries

This already rules out 90% of protobuf‑style solutions.

You’re also correct that:

    we do not want dynamic message upgrading at runtime
    we do not want implicit compatibility
    we do not want “best effort” decoding
    we do not want field‑number gymnastics

So the question becomes:

    How do we detect protocol mismatches without introducing a schema bureaucracy?

🌿 The two options you proposed

Let’s examine them in the context of t2‑agc’s design goals.
Option A — A version string field in the protocol metadata

This is simple and explicit:

(defprotocol Counter
  (:version "v1.2.0")
  (:inc n)
  (:get from)
  (:reset))

Pros

    human‑readable
    tools can compare versions
    Dlite can warn on mismatches
    debugging tools can show version info
    supports semantic versioning or arbitrary strings
    no runtime overhead

Cons

    version strings don’t guarantee structural compatibility
    developers can lie
    tools must interpret version semantics

Still: this is a good baseline.
Option B — A structural hash of the protocol

This is more rigorous:

    compute a hash of the message shapes
    embed it in the protocol metadata
    sender and receiver compare hashes
    mismatch → warning or error

Pros

    guarantees structural identity
    no human interpretation
    perfect for Dlite
    perfect for debugging
    perfect for hot‑swap safety
    zero ambiguity

Cons

    hash changes on any structural change
    requires deterministic hashing of IR
    requires runtime comparison logic

But: this is the most principled solution.
🌳 The real answer: use both

This is the sweet spot:
✔️ A human‑meaningful version string

For documentation, debugging, and static tooling.
✔️ A machine‑checked structural hash

For correctness, safety, and hot‑swap validation.

Together they give you:

    human intent
    machine truth
    analyzability
    runtime safety
    Dlite integration
    zero ambiguity

This is exactly how Git works:

    human‑meaningful tags
    machine‑meaningful hashes

It’s a proven pattern.
🌲 How this fits into t2‑agc
1. Protocol metadata includes both fields

{
  "protocol": "Counter",
  "version": "v1.2.0",
  "hash": "sha256:abc123...",
  "messages": [...]
}

2. Dlite uses both

    version string → warn on mismatches
    hash → error on structural mismatch
    coverage → warn on unanalyzable dynamic messages

3. Runtime uses the hash only

    sender attaches protocol hash
    receiver compares
    mismatch → AGC‑coded warning or escalation

4. Hot‑swap uses both

    version string → human‑visible
    hash → compatibility check

5. No dynamic upgrading

This is important.
t2‑agc should not attempt:

    schema evolution
    field renaming
    optional fields
    backward compatibility logic

If you want a new protocol, you create:

Counter@v2

Just like you version behaviors.
🌵 Why this is better than protobuf‑style evolution

Protobuf tries to solve:

    cross‑team schema drift
    long‑term backward compatibility
    partial upgrades
    rolling deployments
    multi‑language codegen

t2‑agc is solving a different problem:

    local actor protocols
    explicit message shapes
    static analysis
    hot‑swap safety
    debugging clarity

We don’t need:

    field numbers
    optional fields
    reserved fields
    schema registries
    implicit compatibility

We need:

    explicitness
    analyzability
    correctness

Hashes + version strings give you that.
🌞 Final recommendation

Yes — protocols should carry both a version string and a structural hash.

This gives you:
✔️ human‑meaningful versioning
✔️ machine‑checked structural identity
✔️ Dlite compatibility checking
✔️ runtime mismatch detection
✔️ hot‑swap safety
✔️ zero ambiguity
✔️ no protobuf‑style schema bureaucracy

It’s the cleanest, most principled solution for an actor‑native, analyzable concurrency model.
