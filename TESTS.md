# Testing Plan

## Overview

Tests are written in `.t2` files under `tests/`, compiled to `dist-tests/` via
`npm run build-tests`, and run with Vitest (`npm test`).

The existing `tests/ring_buffer.test.t2` is the model: import `describe`/`it`
from `vitest`, import `asrt`/`asrtDeep` from `./asrt`, import the module under
test, and write `(describe ... (lambda () (it ... (lambda () ...))))` blocks.

---

## Test Files

### 1. `tests/match_pattern.test.t2`

**What**: Pure functions — no runtime needed. Fast, deterministic.

| Test case | Checks |
|-----------|--------|
| Wildcard `"_"` matches any value | `match_pattern` returns non-null bindings |
| Symbol pattern binds value | bindings object contains symbol key |
| Literal string — match | returns bindings |
| Literal string — mismatch | returns `null` |
| Literal number — match / mismatch | same |
| Array pattern — exact match | recursive structural match |
| Array pattern — wrong length | returns `null` |
| Array pattern — nested wildcard | partial binding |
| `try_match_patterns` — first clause matches | returns `true` |
| `try_match_patterns` — no clause matches | returns `false` |
| `compute_match_result` — returns `{matched_pattern_index, bindings}` | index and bindings populated |

---

### 2. `tests/capability.test.t2`

**What**: `Capability` class and factory functions. No runtime needed.

| Test case | Checks |
|-----------|--------|
| `make_log_capability` has type `"log"` | `cap_type` field |
| `make_log_capability` `can_perform("info")` → true | positive check |
| `make_log_capability` `can_perform("write")` → false | negative check |
| `make_io_capability` has type `"io"` | `cap_type` field |
| `make_io_capability` `can_perform("fetch")` → true | positive check |
| `make_timer_capability` operations include `"sleep"` | `can_perform` |
| `make_random_capability` operations include `"next"` | `can_perform` |
| Each capability has a unique `id` | two instances have different IDs |
| `metadata` stored on `make_io_capability` | `metadata.allowedHosts` populated |

---

### 3. `tests/scheduler.test.t2`

**What**: Integration tests using `init_runtime` + `spawn` + `run`. Each test
calls `init_runtime()` to get a fresh scheduler.

| Test case | Checks |
|-----------|--------|
| Spawn a simple task that returns immediately | task reaches `status = "done"` after `run()` |
| Two tasks run to completion | both tasks done, correct execution count |
| Priority ordering — critical before normal | critical task runs first |
| Task budget: budget exhausted, task re-queued | task completes across multiple slices |
| Task can read its own name via `gen_fn.name` | `task.name` set from function name |
| `debug.list_tasks()` returns correct task info | pid, name, status, priority present |
| `debug.dump_task(pid)` returns full task detail | mailbox, capabilities, stats |
| Unknown primitive type emits `AGC-S999` | `debug.get_agc_codes(10)` contains it |
| Monitoring callback fires on spawn | callback receives event with `type: "spawn"` |

---

### 4. `tests/send_receive.test.t2`

**What**: Message passing between two tasks via `send`/`receive`.

| Test case | Checks |
|-----------|--------|
| Task A sends to task B; B receives | B resumes with the sent value |
| Selective receive: correct pattern fires | `matched_pattern_index` is the right index |
| Selective receive: second pattern fires when first doesn't match | index 1 body runs |
| Send to non-existent pid emits `AGC-M050` | AGC code in `agc_codes_emitted` |
| Mailbox `drop-oldest` overflow: oldest message dropped | oldest not present after overflow |
| Mailbox `drop-newest` overflow: new message silently dropped | last sent not present |
| Mailbox `reject` overflow: sender gets `["mailbox_full", pid]` back | sender mailbox contains error tuple |
| Mailbox `escalate` overflow: target task crashes | target `status = "crashed"` |
| `total_messages_sent` / `total_messages_received` counters | stats incremented correctly |

---

### 5. `tests/otp.test.t2`

**What**: Registry and supervisor tasks (high-level wiring).

| Test case | Checks |
|-----------|--------|
| Registry: register → whereis returns pid | correct pid looked up |
| Registry: unregister → whereis returns undefined | key gone |
| Supervisor `permanent`: crashed child is restarted | new pid exists after run |
| Supervisor `temporary`: normally-exiting child is NOT restarted | children map not updated |
| Supervisor `transient`: abnormal exit restarts child | new pid present |
| `restart_child` returns a valid pid | pid is a number, task exists in scheduler |
| `which_children` message returns current children map | map returned to querying task |

---

## Test Infrastructure

### `tests/asrt.t2` (existing)
`asrt(actual, expected)` — strict equality (`!==`).  
`asrtDeep(actual, expected)` — deep equality via `JSON.stringify`.

### Helper: `tests/t2agc_test_util.t2` (new)
A small helper module to remove boilerplate from runtime integration tests:

```t2
;; t2agc_test_util.t2
;; Provides: fresh_runtime() — calls init_runtime and returns the scheduler,
;;           run_until_done() — calls run(), returns debug snapshot.
```

---

## Build Integration

### Current `package.json` `build-tests` script

Needs to be updated to include the new files. Suggested script:

```json
"build-tests": "rimraf dist-tests && npx t2tc --outDir dist-tests src/array_util.t2 src/ring_buffer.t2 src/types.t2 src/agc_event.t2 src/capability.t2 src/match_pattern.t2 src/task.t2 src/scheduler.t2 src/macros.t2m src/runtime*.t2 src/otp.t2 tests/*.t2"
```

> **Note**: `t2tc` must compile all transitive dependencies alongside each test
> file in the same `--outDir` pass, or use separate compilations that output to
> the same directory. The current approach (explicit list) is the safest.

---

## Test Order / Dependencies

```
match_pattern.test   ← no deps (pure functions)
capability.test      ← no deps (pure class)
scheduler.test       ← depends on full runtime stack (init_runtime, spawn, run)
send_receive.test    ← depends on scheduler; exercises Task mailbox paths
otp.test             ← depends on scheduler + macros; highest-level
```

Run in this order when debugging failures — a failure in `match_pattern.test`
will likely cascade into `scheduler.test` and `send_receive.test`.

---

## AGC Code Coverage

Where possible, tests should assert that expected AGC diagnostic codes appear
(or don't appear) using `debug.get_agc_codes(n)`:

| Code | Trigger |
|------|---------|
| `AGC-M010` | Mailbox overflow (any policy) |
| `AGC-M050` | Send to non-existent pid |
| `AGC-S999` | Task crash / unknown primitive |
