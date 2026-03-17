/**
 * Tests for Task — the cooperative execution unit with mailbox, history, and
 * capability tracking.
 */

import { describe, it } from 'vitest';
import { fromSourceEndToEnd } from './helpers.js';

// Shared inline definitions for Task tests.
const RING_BUFFER_DEF = `
(class RingBuffer
  (class-body
    (field (buffer      : (type-array any)))
    (field (write_index : number) 0)
    (field (count       : number) 0)
    (constructor ((public size : number))
      (set! (. this buffer) (new Array size)))
    (method push ((item : any)) (returns void)
      (method-call (. this buffer) splice (. this write_index) 1 item)
      (set! (. this write_index) (% (+ (. this write_index) 1) (. this size)))
      (if (< (. this count) (. this size))
        (begin (set! (. this count) (+ (. this count) 1)))
        undefined))
    (method to_array () (returns (type-array any))
      (if (< (. this count) (. this size))
        (method-call (. this buffer) slice 0 (. this count))
        (method-call
          (method-call (. this buffer) slice (. this write_index))
          concat
          (method-call (. this buffer) slice 0 (. this write_index)))))))
`;

const CAPABILITY_DEF = `
(class Capability
  (class-body
    (field (id : string) "")
    (constructor
      ((public type       : string)
       (public operations : (type-array string))
       (public metadata   : any))
      (set! (. this id) (method-call crypto randomUUID)))
    (method can_perform ((operation : string)) (returns boolean)
      (method-call (. this operations) includes operation))))
`;

const TASK_DEF = `
(class Task
  (class-body
    (field (name                          : string)                    "")
    (field (status                        : string)                    "runnable")
    (field (gen                           : any))
    (field (budget                        : number)                    100)
    (field (initial_budget                : number)                    100)
    (field (mailbox                       : (type-array any))          (array))
    (field (mailbox_max                   : number)                    1000)
    (field (mailbox_overflow_policy       : string)                    "drop-oldest")
    (field (waiting_patterns              : any)                       null)
    (field (pending_resume                : any))
    (field (history_effects               : RingBuffer))
    (field (history_exceptional           : RingBuffer))
    (field (history_critical              : RingBuffer))
    (field (created_at                    : number)                    0)
    (field (total_reductions              : number)                    0)
    (field (total_messages_sent           : number)                    0)
    (field (total_messages_received       : number)                    0)
    (field (mailbox_scan_count            : number)                    0)
    (field (total_mailbox_scan_operations : number)                    0)

    (constructor
      ((public id           : number)
       (gen_fn              : any)
       (args                : (type-array any))
       (public priority     : string)
       (public capabilities : any))
      (set! (. this name)
        (or (. gen_fn name) (+ "task-" (string id))))
      (set! (. this gen)                 (method-call gen_fn apply null args))
      (set! (. this history_effects)     (new RingBuffer 100))
      (set! (. this history_exceptional) (new RingBuffer 50))
      (set! (. this history_critical)    (new RingBuffer 20))
      (set! (. this created_at)          (method-call Date now)))

    (method record_effect ((capability : any) (operation : string) (args : (type-array any))) (returns void)
      (method-call (. this history_effects) push
        (object
          (timestamp  (method-call Date now))
          (capability (. capability id))
          (operation  operation)
          (args       args))))

    (method record_exceptional ((event_type : string) (data : any)) (returns void)
      (method-call (. this history_exceptional) push
        (object
          (timestamp (method-call Date now))
          (type      event_type)
          (data      data))))

    (method record_critical ((code : string) (message : string)) (returns void)
      (method-call (. this history_critical) push
        (object
          (timestamp (method-call Date now))
          (code      code)
          (message   message))))

    (method configure_mailbox ((max_size : number) (overflow_policy : string)) (returns void)
      (set! (. this mailbox_max)             max_size)
      (set! (. this mailbox_overflow_policy) overflow_policy))))
`;

describe('Task', () => {
  it('constructor sets default field values', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      (let (gen_fn) (generator-fn () (yield 1)))
      (let (t) (new Task 0 gen_fn (array) "normal" (new Set)))
      (asrt (. t status)                  "runnable")
      (asrt (. t priority)                "normal")
      (asrt (. t budget)                  100)
      (asrt (. t mailbox_max)             1000)
      (asrt (. t mailbox_overflow_policy) "drop-oldest")
      (asrt (. (. t mailbox) length)      0)
    )`);
  });

  it('name defaults to "task-<id>" when generator has no name', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      (let (t) (new Task 7 (generator-fn () (yield 1)) (array) "low" (new Set)))
      (asrt (. t name) "task-7")
    )`);
  });

  it('record_effect stores to history_effects ring buffer', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      (let (t)   (new Task 1 (generator-fn () (yield 1)) (array) "normal" (new Set)))
      (let (cap) (new Capability "log" (array "info") (object)))
      ((. t record_effect) cap "info" (array "hello"))
      (let (history) ((. (. t history_effects) to_array)))
      (asrt (. history length) 1)
      (asrt (. (index history 0) operation) "info")
    )`);
  });

  it('record_exceptional stores to history_exceptional', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      (let (t) (new Task 2 (generator-fn () (yield 1)) (array) "normal" (new Set)))
      ((. t record_exceptional) "blocked_on_receive" (object))
      (let (history) ((. (. t history_exceptional) to_array)))
      (asrt (. history length) 1)
      (asrt (. (index history 0) type) "blocked_on_receive")
    )`);
  });

  it('record_critical stores to history_critical', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      (let (t) (new Task 3 (generator-fn () (yield 1)) (array) "normal" (new Set)))
      ((. t record_critical) "AGC-CAP500" "Unauthorized capability usage")
      (let (history) ((. (. t history_critical) to_array)))
      (asrt (. history length) 1)
      (asrt (. (index history 0) code) "AGC-CAP500")
    )`);
  });

  it('configure_mailbox updates max and overflow policy', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      (let (t) (new Task 4 (generator-fn () (yield 1)) (array) "normal" (new Set)))
      ((. t configure_mailbox) 500 "drop-newest")
      (asrt (. t mailbox_max)             500)
      (asrt (. t mailbox_overflow_policy) "drop-newest")
    )`);
  });
});
