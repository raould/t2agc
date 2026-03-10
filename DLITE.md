# Dialyzer‑lite (Dlite) for t2‑agc  
### Protocol‑ and behavior‑oriented static analysis for the t2‑agc ecosystem

---

## 1. Purpose and scope

**Dialyzer‑lite (Dlite)** is a static analysis tool for the **t2‑agc + t2‑agc‑otp** ecosystem. Its focus is:

- **Message protocols**, not arbitrary JS typing.  
- **Actor semantics**: tasks, mailboxes, behaviors, supervisors.  
- **Opaque types** and **selective receive**.  
- **Coverage reporting**: what *was* analyzed and what *was not*.

Dlite is not a general JS type checker. It is a **protocol and behavior checker** for t2‑lang code that targets t2‑agc.

---

## 2. Inputs and model

### 2.1 Inputs

Dlite operates on:

- **t2‑lang IR** after macro expansion:
  - `task`, `spawn`, `send`, `receive`, `effect`, etc.
- **Behavior declarations**:
  - `server`, `worker`, `state-machine`, `supervisor`.
- **Protocol declarations**:
  - `defprotocol` (message shapes).
- **Opaque type declarations**:
  - `defopaque`.
- **Source locations**:
  - file, line, column for all relevant forms.

### 2.2 Internal model

Dlite builds:

- a **symbol table**:
  - tasks, behaviors, protocols, opaque types.
- a **message flow graph**:
  - nodes: tasks/behaviors.
  - edges: `send` sites with inferred message shapes.
- a **pattern table**:
  - `receive` clauses and their patterns.
- a **usage map**:
  - where opaque types are constructed, passed, and matched.

---

## 3. Core analyses

### 3.1 Message protocol analysis

**Goal:** ensure `send` and `receive` agree on message shapes defined by protocols.

#### 3.1.1 Protocol collection

From:

```t2
(defprotocol Counter
  (:inc n)
  (:get from))
```

Dlite records:

- protocol name: `Counter`
- allowed message shapes:
  - `(:inc n)`
  - `(:get from)`

#### 3.1.2 Send analysis

For each `send pid msg`:

- infer the **shape** of `msg` (tag + arity + argument positions).
- infer the **intended protocol** for `pid`:
  - via behavior metadata (e.g. `server Counter`).
  - via registry annotations (optional).
- check:
  - if `msg` matches any shape in the protocol:
    - OK.
  - else:
    - emit `AGC-PROT200` (protocol mismatch).

#### 3.1.3 Receive analysis

For each `receive` in a protocol‑implementing behavior:

- collect patterns and their shapes.
- check:
  - all protocol messages are handled by at least one clause, or
  - explicitly ignored via wildcard with annotation.

If a protocol message is never handled:

- emit `AGC-PROT210` (unhandled protocol message).

If a receive clause can never match any protocol message:

- emit `AGC-PROT220` (unreachable receive clause).

---

### 3.2 Opaque type analysis

**Goal:** enforce encapsulation and safe usage of `defopaque` types.

#### 3.2.1 Opaque type collection

From:

```t2
(defopaque Counter
  (value))
```

Dlite records:

- opaque type: `Counter`
- constructors and accessors (from macro expansion).
- tag used for pattern matching.

#### 3.2.2 Construction

Dlite checks:

- only generated constructors create `Counter` values.
- any manual construction of tagged values → `AGC-T110` (invalid constructor usage).

#### 3.2.3 Access

Dlite checks:

- only generated accessors read internals.
- direct field access or structural pattern matching on internals → `AGC-T120` (invalid accessor usage).

#### 3.2.4 Pattern matching

Dlite encourages:

- matching on the opaque tag, not internals.

E.g.:

```t2
(receive
  ((Counter c)) => ...)
```

is valid; destructuring internals is not.

---

### 3.3 Behavior contract analysis

**Goal:** ensure behaviors implement their declared contracts.

For each behavior instance:

- **Server**:
  - expected message shapes (from protocol or options).
  - expected reply patterns.
- **Worker**:
  - expected job shapes.
- **State‑machine**:
  - allowed states and transitions.
- **Supervisor**:
  - child spec shapes.

Dlite checks:

- required callbacks exist.
- callbacks return expected shapes.
- declared messages are handled in `receive`.

Diagnostics:

- `AGC-BEH300` – missing required callback.  
- `AGC-BEH310` – wrong return shape for behavior callback.  
- `AGC-BEH320` – behavior declares protocol but never replies.

---

### 3.4 Selective receive and mailbox analysis

**Goal:** catch protocol‑level mailbox issues statically.

Dlite uses:

- known sends → known message shapes.
- known receives → known patterns.

It detects:

- **unreachable receive clauses**:
  - pattern never matches any known message → `AGC-PROT220`.
- **unhandled messages**:
  - known message shape never matched by any receive → `AGC-PROT210`.

Runtime warnings (from t2‑agc) complement this with dynamic data; Dlite provides static hints.

---

## 4. Coverage analysis (COV)

### 4.1 Purpose

Dlite should not only say “here are the problems”, but also:

> “Here is what I could not analyze.”

This helps developers:

- stay within the **analyzable core** of t2‑lang.  
- identify dynamic or opaque areas.  
- gradually improve coverage.

### 4.2 Coverage dimensions

Dlite tracks:

- **Tasks**:
  - analyzed vs not analyzed.
- **Send sites**:
  - protocol‑checked vs unanalyzable.
- **Receive clauses**:
  - pattern‑checked vs too dynamic.
- **Opaque types**:
  - fully checked vs missing metadata.
- **Behaviors**:
  - fully checked vs partially or not checked.

### 4.3 Reasons for non‑analysis

Examples:

- dynamic message shapes (constructed from arbitrary JS).  
- unknown target pid (no protocol/behavior metadata).  
- receive patterns too dynamic (e.g. arbitrary JS structures).  
- opaque types used without `defopaque` metadata.  
- behaviors implemented manually without behavior macros.  
- code paths that escape into raw JS where IR is not annotated.

### 4.4 Coverage diagnostics (COV codes)

New AGC category: **COV**.

Examples:

- `AGC-COV400` – dynamic message shape not analyzable.  
- `AGC-COV410` – unknown target pid; cannot check protocol.  
- `AGC-COV420` – receive pattern too dynamic for analysis.  
- `AGC-COV430` – opaque type missing metadata.  
- `AGC-COV440` – behavior implemented manually; limited analysis.  
- `AGC-COV450` – code path escapes analyzable subset.

These are **warnings**, not errors.

### 4.5 Coverage report

Dlite can emit a summary like:

```text
Dlite Coverage Report
---------------------

Analyzed:
  ✓ 12 / 15 tasks
  ✓ 8 / 10 behaviors
  ✓ 42 / 60 send sites
  ✓ 37 / 55 receive clauses
  ✓ 5 / 7 opaque types
  ✓ 3 / 4 protocols

Not Analyzed:
  ✗ task WorkerX: dynamic message shapes (AGC-COV400) at worker.t2:12
  ✗ send: unknown target pid (AGC-COV410) at router.t2:45
  ✗ receive: pattern too dynamic (AGC-COV420) at misc.t2:88
  ✗ opaque type Foo: missing defopaque metadata (AGC-COV430)
  ✗ behavior ChatRoom: manual implementation (AGC-COV440)

Approximate coverage: 78%
```

This gives teams a **roadmap** for making more of their code analyzable.

---

## 5. Architecture and phases

### 5.1 Phases

1. **Front‑end**  
   - Load IR + metadata.  
   - Normalize macros (behaviors, protocols, opaque types).

2. **Symbol & protocol table**  
   - Build maps for tasks, behaviors, protocols, opaque types.

3. **Message flow graph**  
   - Build edges for `send` sites with inferred shapes.  
   - Annotate edges with protocol info where possible.

4. **Analyses**  
   - Protocol analysis.  
   - Opaque type analysis.  
   - Behavior contract analysis.  
   - Selective receive analysis.  
   - Coverage analysis.

5. **Reporting**  
   - Emit AGC‑coded diagnostics.  
   - Emit coverage report.  
   - Optionally export JSON for editor tooling.

---

## 6. Output and UX

### 6.1 CLI

Command:

```bash
t2agc-dlite path/to/project
```

Outputs:

- diagnostics (errors/warnings) with AGC codes.  
- coverage summary.  

Example:

```text
AGC-PROT200 [Counter] send uses unknown message shape at counter_client.t2:42
AGC-T120    [Counter] direct field access to opaque type at impl.t2:15
AGC-BEH300  [MyServer] missing handle-call for (:get ...) at server.t2:10
AGC-COV410  unknown target pid; cannot check protocol at router.t2:45
```

### 6.2 Editor integration

Via LSP:

- diagnostics surfaced inline.  
- quick‑fix suggestions (e.g. “Add receive clause for (:inc n)”).  
- coverage indicators (e.g. gutter markers for unanalyzed regions).

---

## 7. Non‑goals

Dlite does **not**:

- type‑check arbitrary JS.  
- implement full HM or gradual typing.  
- guarantee absence of all runtime errors.  

It **does**:

- make message protocols explicit and checked.  
- enforce opaque type boundaries.  
- validate behavior contracts.  
- catch many actor‑level bugs before runtime.  
- show you where you’ve left the analyzable subset.

---

## 8. Summary

Dlite is:

- a **protocol‑centric** static analyzer for t2‑agc.  
- aware of **tasks, behaviors, protocols, opaque types, selective receive**.  
- integrated with **AGC‑coded diagnostics**.  
- capable of **coverage reporting** so you know what it didn’t analyze.  

It’s not trying to be a general JS type system.  
It’s a **reliability and discipline tool** for the t2‑agc ecosystem—helping developers stay within a **small, analyzable, actor‑friendly core** while still living in the JavaScript world.
