# **t2‑agc**  

### *Why this ecosystem exists, what it stands for, and what it refuses to be*

---

## 1. Purpose

t2‑agc exists to bring **deterministic, actor‑style concurrency** to the JavaScript universe — without requiring developers to abandon the ecosystem, tools, and workflows they rely on.

It is not a competitor to Erlang, Pony, or Akka.  
It is a **bridge** that brings their best ideas into environments where they cannot run:

- browsers  
- Node/Deno/Bun  
- Cloudflare Workers  
- Electron  
- React Native  
- embedded JS runtimes  

t2‑agc is for teams who want **Erlang‑grade reliability** but must remain in the JS world.

---

## 2. Core Beliefs

### **2.1 Concurrency should be explicit, deterministic, and inspectable**  
JavaScript’s async model is opaque, nondeterministic, and difficult to reason about.  
t2‑agc replaces this with:

- explicit tasks  
- explicit yields  
- explicit capabilities  
- explicit message protocols  
- explicit state transitions  

No hidden threads.  
No hidden async.  
No magic.

### **2.2 Debugging should be first‑class, not an afterthought**  
The runtime exposes:

- task tables  
- mailbox contents  
- woven timelines  
- AGC‑coded warnings  
- effect histories  
- scheduler state  

If something goes wrong, you should be able to *see* it.

### **2.3 Safety comes from structure, not from trust**  
t2‑agc enforces:

- capability‑based effects  
- bounded mailboxes  
- protocol‑checked messages  
- analyzable state machines  
- deterministic scheduling  

This is not “JavaScript with actors.”  
It is a **structured concurrency model** with guardrails.

### **2.4 The system must remain tiny, predictable, and hackable**  
t2‑agc is not a VM.  
It is a small, transparent runtime you can read in an afternoon.

No JIT.  
No GC tricks.  
No opaque scheduler heuristics.

### **2.5 Adoption must be incremental**  
You can adopt t2‑agc:

- in one file  
- in one module  
- in one subsystem  
- without rewriting your app  
- without retraining your team  

This is essential for real‑world teams.

---

## 3. What t2‑agc *is*

### **3.1 A deterministic, cooperative scheduler**  
Inspired by the Apollo Guidance Computer:

- bounded work  
- explicit yields  
- priority buckets  
- overload detection  

### **3.2 A message‑passing actor runtime**  
With:

- tasks  
- mailboxes  
- selective receive  
- pattern matching  
- protocol metadata  

### **3.3 A capability‑based effect system**  
Effects require explicit authority.  
No ambient power.

### **3.4 A structured debugging architecture**  
Everything is observable.

### **3.5 A foundation for OTP‑style reliability**  
Supervisors, behaviors, routers, pools, shared blobs.

### **3.6 A platform for static analysis (Dlite)**  
Protocols, opaque types, state machines, capabilities — all analyzable.

---

## 4. What t2‑agc is *not*

### **4.1 Not a VM**  
No BEAM.  
No green threads.  
No per‑process heaps.

### **4.2 Not a replacement for Erlang**  
If you can use Erlang, you should.  
t2‑agc is for environments where Erlang cannot run.

### **4.3 Not a general type system**  
Dlite is protocol‑centric, not a TypeScript competitor.

### **4.4 Not a framework**  
No monolithic abstractions.  
No magic lifecycle.  
No hidden global state.

### **4.5 Not a rewrite‑your‑app proposition**  
Incremental adoption is a core requirement.

---

## 5. Why not “just use Erlang”?

Because most teams cannot:

- rewrite their entire stack  
- retrain their entire team  
- abandon npm  
- abandon browser environments  
- abandon Node/Deno/Bun  
- abandon existing infra  
- abandon existing debugging tools  

t2‑agc brings Erlang’s *principles* — not its VM — into the JS world.

---

## 6. Why not “just use JS async”?

Because JS async:

- hides scheduling  
- hides fairness  
- hides backpressure  
- hides message ordering  
- hides effect boundaries  
- hides overload  
- hides failure modes  

t2‑agc makes all of these explicit.

---

## 7. Why not “just use Web Workers / Node workers”?

Because workers:

- are heavyweight  
- have no selective receive  
- have no supervision  
- have no protocols  
- have no structured debugging  
- have no deterministic scheduling  
- have no capability system  
- have no static analysis  

Workers are a primitive.  
t2‑agc is a **model**.

---

## 8. The t2‑agc Promise

t2‑agc promises:

### ✔️ Determinism  
### ✔️ Explicitness  
### ✔️ Debuggability  
### ✔️ Reliability  
### ✔️ Safety  
### ✔️ Incremental adoption  
### ✔️ Smallness  
### ✔️ Transparency  
### ✔️ JS ecosystem compatibility  

It is a concurrency model designed for:

- real‑time apps  
- multiplayer systems  
- collaborative editors  
- simulations  
- reactive UIs  
- distributed protocols  
- agent‑based systems  
- long‑running services  

Anywhere you need **predictable, observable, actor‑style concurrency** — without leaving JavaScript.

---

## 9. The Long‑Term Vision

t2‑agc aims to become:

- the **actor runtime** for JS  
- the **structured concurrency layer** JS never had  
- the **debuggable concurrency model** developers deserve  
- the **foundation** for agent‑native architectures  
- the **bridge** between JS and Erlang‑style reliability  
- the **ecosystem** where correctness tools (Dlite) thrive  

It is not a toy.  
It is a principled, long‑term architecture for building reliable systems in the JS universe.
