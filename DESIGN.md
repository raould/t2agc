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

```
(:tag arg1 arg2 ...)
```

They are immutable and pattern‑matchable.

## 3.2 Mailboxes  
Each task has a private mailbox:

- append‑only on `send`  
- scanned on `receive`  
- supports selective receive  
- supports AGC‑coded warnings for unhandled messages  

## 3.3 Selective Receive  
Selective receive allows a task to:

- scan its mailbox  
- match messages by pattern  
- remove only the matched message  
- leave unmatched messages in place  

This is a **core runtime semantic**, not an OTP feature.

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

## 3.5 Capabilities  
Effects (I/O, timers, shared blobs, etc.) are accessed via **capabilities**.  
Tasks cannot perform effects without explicit capabilities.

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
