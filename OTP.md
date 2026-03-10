Absolutely — here is the **updated, fully integrated t2‑agc‑otp design doc**, now including:

- **Opaque types** (Erlang‑style encapsulation, JS‑class‑backed)
- **Dialyzer‑lite** (message‑protocol and behavior‑contract checking)
- All previously defined OTP‑style features (supervisors, behaviors, registries, routers, shared blobs, ETS‑lite, backpressure, overload handling, hot‑swap patterns)

This version is cohesive, principled, and ready to stand alongside the updated t2‑agc core doc.

---

# 🌟 **t2‑agc‑otp: High‑Level Design Document (Updated)**  
### *OTP‑style patterns for a tiny, deterministic AGC‑inspired runtime*

t2‑agc‑otp is a **small, principled library + macro layer** that brings the *essence* of Erlang/OTP, Akka, and Pony into the t2‑agc ecosystem:

- supervision  
- behaviors  
- registries and routers  
- backpressure and overload handling  
- disciplined shared state  
- hot‑swap‑friendly structure  
- opaque types  
- Dialyzer‑lite protocol checking  

It is intentionally **not** a monolithic framework. Everything remains:

- explicit  
- inspectable  
- debuggable  
- AGC‑coded  
- compatible with t2‑agc’s deterministic scheduler  

---

# 1. Positioning and Architecture

t2‑agc‑otp sits **above** the t2‑agc kernel:

```text
Your app code
   ↑
t2-agc-otp (supervisors, behaviors, registries, routers, shared blobs, opaque types)
   ↑
t2-agc core (tasks, spawn, send, receive, selective receive, scheduler, logging)
   ↑
JS runtime (browser / Node / Deno / Bun)
```

### Design principles

- **Small**: no giant framework, just macros + tiny helpers  
- **Explicit**: no hidden threads, no hidden async  
- **Model‑reinforcing**: everything encourages actor thinking  
- **Debuggable**: all behavior visible in `__t2agc__`  
- **Versionable**: supports rolling hot‑swap patterns  

---

# 2. Supervisors, Trees, and Failure Recovery

Supervisors are tasks that:

- own **child specs**  
- apply **restart strategies**  
- enforce **restart limits**  
- log failures with **AGC codes**  
- form **supervision trees**  

### Child spec fields

- `:id`  
- `:start` (function or behavior)  
- `:restart` (`:permanent | :transient | :temporary`)  
- `:shutdown` (timeout)  
- `:type` (`:worker | :supervisor`)  

### Restart strategies

- `:one-for-one`  
- `:one-for-all`  
- `:rest-for-one`  

### Failure reporting

When a child fails:

- t2‑agc emits an exceptional event (e.g. `AGC-P999`)  
- child sends `(:exit id reason)` to supervisor  
- supervisor logs + restarts according to policy  

### Supervision tree introspection

Debug helpers:

- `ppTree()`  
- `listSupervisors()`  
- `dumpSupervisor(id)`  

---

# 3. Registries, Routers, and Pools

## 3.1 Registry (name → pid)

A registry task supports:

- `(:register name pid)`  
- `(:unregister name)`  
- `(:whereis name)`  

Used for:

- routing  
- hot‑swap indirection  
- supervision tree wiring  

## 3.2 Routers

Routers are tasks that forward messages to workers:

- **round‑robin**  
- **broadcast**  
- **hash‑based**  

Routers:

- are supervised  
- can be registered  
- can enforce backpressure  

## 3.3 Pools

A pool = router + worker set:

- scalable  
- supervised  
- backpressure‑aware  

---

# 4. Shared Blobs and ETS‑Lite

## 4.1 SharedBlob utility

A disciplined way to share large data:

- pure reads  
- `withLock(fn)` for controlled mutation  
- logs access as effect events  
- warns on long‑held locks (AGC‑E0xx)  
- access mediated via capability  

## 4.2 ETS‑lite (table‑owning actor)

A task that owns a map:

- `(:get key from)`  
- `(:put key value)`  
- `(:delete key)`  
- `(:snapshot from)`  

Optional:

- backed by SharedBlob  
- supervised  
- registered  

This preserves the actor model:

> “State lives in a task; access is via messages.”

---

# 5. Micro Behavior Library

Behaviors are **just macros** expanding to tasks + receive loops.

## 5.1 `server` behavior

- internal state  
- request/response  
- optional timeouts  
- backpressure policies  

## 5.2 `worker` behavior

- receives jobs  
- processes them  
- sends results  
- pool‑friendly  

## 5.3 `state-machine` behavior

- explicit state  
- transitions via messages  
- optional timers  

## 5.4 `supervisor` behavior

- child specs  
- restart strategy  
- restart limits  
- logging hooks  

All behaviors integrate with:

- selective receive  
- AGC‑coded warnings  
- timeline weaving  

---

# 6. Backpressure and Overload Handling

## 6.1 Mailbox‑level backpressure

Per‑task options:

- `:max-mailbox N`  
- `:on-overflow :drop-oldest | :drop-newest | :reject | :escalate`  

Warnings:

- `AGC-M010` mailbox overflow  
- `AGC-M020` slow consumer  

## 6.2 System‑level overload

Scheduler monitors:

- run queue length  
- slice duration  
- effect latency  
- task counts per priority bucket  

On overload:

- emit `AGC-S100`  
- optionally enter **emergency mode**  
- drop idle/low tasks  

## 6.3 Behavior‑level backpressure

Behaviors can declare:

- `:max-concurrent-jobs`  
- `:max-subscribers`  
- `:max-pending-requests`  

---

# 7. Hot‑Swap‑Friendly Structure

Full Erlang hot upgrade is out of scope; instead we use:

## 7.1 Versioned behaviors

- `chat-room@v1`  
- `chat-room@v2`  

Versioning is a naming convention.

## 7.2 Registry indirection

Clients send to logical names, not raw pids.

## 7.3 Rolling restart pattern

1. Load new behavior  
2. Spawn new tasks  
3. Update registry  
4. Drain + stop old tasks  

This is **hot swap by replacement**, not mutation.

## 7.4 Runtime‑specific adapters

Optional helpers for:

- Node  
- Deno  
- Bun  
- Browser  

But the core pattern is runtime‑agnostic.

---

# 8. Opaque Types (New Section)

Opaque types provide:

- encapsulation  
- pattern‑matching friendliness  
- hot‑swap safety  
- protocol clarity  
- Dialyzer‑lite integration  

## 8.1 `defopaque` macro

Defines:

- a JS‑class‑backed internal representation  
- a unique tag (Symbol)  
- constructor macro  
- accessor macros  
- pattern‑matchable tag  

Example:

```t2
(defopaque Counter
  (value))
```

Opaque values appear in messages as:

```
{:Counter <opaque>}
```

Pattern matching sees only the tag, not internals.

## 8.2 Why opaque types matter

- callers cannot inspect internals  
- internal representation can change across versions  
- message protocols become explicit  
- Dialyzer‑lite can reason about them  
- debugging is cleaner (no giant objects in logs)  

---

# 9. Dialyzer‑Lite (New Section)

A static analysis tool for:

- message protocol checking  
- behavior callback checking  
- opaque type usage  
- unhandled message detection  
- shape mismatches in `send`  
- unreachable receive clauses  
- mailbox starvation patterns  

## 9.1 What it checks

### ✔️ Message protocols  
If a behavior declares:

```t2
(defprotocol Counter
  (:inc n)
  (:get from))
```

Dialyzer‑lite checks:

- all sends match protocol  
- all receives handle protocol  
- no unexpected messages remain unhandled  

### ✔️ Opaque type usage  
Ensures:

- only constructors create opaque values  
- only accessors read internals  
- pattern matching uses tags, not internals  

### ✔️ Behavior contracts  
Checks that:

- server callbacks return expected shapes  
- state‑machine transitions are valid  
- supervisor child specs are well‑formed  

### ✔️ Selective receive correctness  
Detects:

- receive clauses that never match  
- mailbox messages that never get handled  
- starvation due to selective receive  

## 9.2 Output

Dialyzer‑lite emits:

- warnings with AGC codes  
- structured reports  
- optional integration with editor tooling  

---

# 10. Integration with Logging, AGC Codes, and Debugging

Everything in t2‑agc‑otp:

- emits AGC‑coded events  
- writes into per‑task and orchestrator histories  
- appears in woven timelines  
- is inspectable via `__t2agc__.debug`  

Opaque types and Dialyzer‑lite add:

- `AGC-T100` opaque type misuse  
- `AGC-T110` invalid constructor usage  
- `AGC-T120` invalid accessor usage  
- `AGC-PROT200` protocol mismatch  
- `AGC-PROT210` unhandled protocol message  
- `AGC-PROT220` unreachable receive clause  

---

# 11. What t2‑agc‑otp Does *Not* Include

To keep the system small:

- ❌ No full database abstractions  
- ❌ No distributed actor system  
- ❌ No full hot‑code upgrade machinery  
- ❌ No ORMs or persistence layers  

These belong in userland or separate libraries.

---

# 12. Summary

t2‑agc‑otp now includes:

### ✔️ Supervisors + supervision trees  
### ✔️ Registries, routers, pools  
### ✔️ SharedBlob + ETS‑lite  
### ✔️ Micro behaviors (server, worker, state‑machine, supervisor)  
### ✔️ Backpressure + overload handling  
### ✔️ Hot‑swap‑friendly patterns  
### ✔️ Opaque types (JS‑class‑backed, pattern‑matchable)  
### ✔️ Dialyzer‑lite (protocol + type + behavior checking)  
### ✔️ Full integration with AGC codes + debugging  

This is a **complete, principled, modern OTP‑style layer** built on top of a tiny, deterministic, AGC‑inspired runtime.
