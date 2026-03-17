/**
 * Tests for Scheduler — the cooperative execution engine.
 *
 * These tests exercise isolated, self-contained pieces of Scheduler behavior:
 * - Priority ordering in pick_next_task
 * - execute_slice drives a generator to completion
 * - emit_agc_code records AGCEvent entries
 * - check_overload fires when the queue crosses the threshold
 */

import { describe, it } from 'vitest';
import { fromSourceEndToEnd } from './helpers.js';

// ── shared inline definitions ─────────────────────────────────────────────────

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

const AGC_EVENT_DEF = `
(class AGCEvent
  (class-body
    (constructor
      ((public code      : string)
       (public message   : string)
       (public timestamp : number)
       (public task_id   : any)
       (public context   : any)))))
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
        (object (timestamp (method-call Date now)) (capability (. capability id)) (operation operation) (args args))))

    (method record_exceptional ((event_type : string) (data : any)) (returns void)
      (method-call (. this history_exceptional) push
        (object (timestamp (method-call Date now)) (type event_type) (data data))))

    (method record_critical ((code : string) (message : string)) (returns void)
      (method-call (. this history_critical) push
        (object (timestamp (method-call Date now)) (code code) (message message))))

    (method configure_mailbox ((max_size : number) (overflow_policy : string)) (returns void)
      (set! (. this mailbox_max)             max_size)
      (set! (. this mailbox_overflow_policy) overflow_policy))))
`;

// ── minimal Scheduler for testing ────────────────────────────────────────────
// Includes only the subset needed for these tests, avoiding complex effects.

const SCHEDULER_CORE = `
(class Scheduler
  (class-body
    (field (run_queues    : any))
    (field (tasks         : any))
    (field (waiting_tasks : any))
    (field (pid_counter   : number) 0)
    (field (current_task  : any)    null)
    (field (tick_count    : number) 0)
    (field (running       : boolean) false)
    (field (total_run_queue_length          : number) 0)
    (field (avg_slice_duration              : number) 0)
    (field (overload_threshold_queue_length : number) 1000)
    (field (overload_threshold_slice_ms     : number) 50)
    (field (orchestrator_history : RingBuffer))
    (field (agc_codes_emitted    : (type-array any)))
    (field (priority_order       : (type-array any)))
    (field (monitoring_callback  : any) null)

    (constructor ()
      (set! (. this run_queues)
        (object
          (critical (array))
          (high     (array))
          (normal   (array))
          (low      (array))
          (idle     (array))))
      (set! (. this tasks)               (new Map))
      (set! (. this waiting_tasks)       (new Map))
      (set! (. this orchestrator_history) (new RingBuffer 200))
      (set! (. this agc_codes_emitted)   (array))
      (set! (. this priority_order)      (array "critical" "high" "normal" "low" "idle")))

    (method next_pid () (returns number)
      (let (pid : number) (. this pid_counter))
      (set! (. this pid_counter) (+ (. this pid_counter) 1))
      pid)

    (method schedule ((task : any)) (returns void)
      (let (priority : string) (. task priority))
      (let (queue : (type-array any)) (index (. this run_queues) priority))
      (method-call queue push task)
      (set! (. this total_run_queue_length)
        (+ (. this total_run_queue_length) 1)))

    (method pick_next_task () (returns any)
      (let (found : any) null)
      (let (i : number) 0)
      (while (and (not found) (< i (. (. this priority_order) length)))
        (let (priority : string) (index (. this priority_order) i))
        (let (queue : (type-array any)) (index (. this run_queues) priority))
        (if (> (. queue length) 0)
          (begin
            (set! (. this total_run_queue_length)
              (- (. this total_run_queue_length) 1))
            (set! found (method-call queue shift)))
          undefined)
        (set! i (+ i 1)))
      found)

    (method record_slice_duration ((duration : number)) (returns void)
      (let (alpha : number) 0.1)
      (set! (. this avg_slice_duration)
        (+ (* alpha duration) (* (- 1 alpha) (. this avg_slice_duration)))))

    (method on_task_completed ((task : any)) (returns void)
      (method-call (. this orchestrator_history) push
        (object (type "task_completed") (timestamp (method-call Date now)) (pid (. task id)))))

    (method on_task_crashed ((task : any) (error : any)) (returns void)
      (set! (. task status) "crashed")
      (method-call this emit_agc_code "AGC-S999"
        (+ "Task " (. task id) " crashed: " (. error message)))
      (method-call task record_exceptional "crashed"
        (object (error (. error message)))))

    (method emit_agc_code ((code : string) (message : string)) (returns void)
      (let (event : any)
        (new AGCEvent code message (method-call Date now)
          (if (. this current_task) (. (. this current_task) id) null)
          (object)))
      (method-call (. this agc_codes_emitted) push event)
      (method-call (. this orchestrator_history) push event)
      (if (. this current_task)
        (begin (method-call (. this current_task) record_critical code message))
        undefined))

    (method check_overload () (returns void)
      (if (> (. this total_run_queue_length) (. this overload_threshold_queue_length))
        (begin
          (method-call this emit_agc_code "AGC-S100"
            (+ "Overload: run queue length " (. this total_run_queue_length))))
        undefined))

    (method execute_slice ((task : any)) (returns void)
      (set! (. this current_task) task)
      (set! (. task budget) (. task initial_budget))
      (let (resume_val : any) (. task pending_resume))
      (set! (. task pending_resume) undefined)
      (let (start_time : number) (method-call Date now))
      (try
        (while (and (> (. task budget) 0) (= (. task status) "runnable"))
          (let (step : any) (method-call (. task gen) next resume_val))
          (set! resume_val undefined)
          (set! (. task budget) (- (. task budget) 1))
          (set! (. task total_reductions) (+ (. task total_reductions) 1))
          (if (. step done)
            (begin
              (set! (. task status) "done")
              (method-call this on_task_completed task))
            (set! resume_val undefined)))
        (catch error
          (method-call this on_task_crashed task error)))
      (let (duration : number) (- (method-call Date now) start_time))
      (method-call this record_slice_duration duration)
      (if (= (. task status) "runnable")
        (begin (method-call this schedule task))
        undefined)
      (set! (. this current_task) null))

    (method run () (returns void)
      (set! (. this running) true)
      (while (. this running)
        (set! (. this tick_count) (+ (. this tick_count) 1))
        (method-call this check_overload)
        (let (task : any) (method-call this pick_next_task))
        (if task
          (method-call this execute_slice task)
          (set! (. this running) false))))))
`;

describe('Scheduler.pick_next_task', () => {
  it('returns null when all queues are empty', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (asrt (method-call s pick_next_task) null)
    )`);
  });

  it('dequeues in priority order: critical before normal', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (let (t_normal)   (new Task 0 (generator-fn () (yield 1)) (array) "normal"   (new Set)))
      (let (t_critical) (new Task 1 (generator-fn () (yield 1)) (array) "critical" (new Set)))
      (method-call s schedule t_normal)
      (method-call s schedule t_critical)
      (let (first) (method-call s pick_next_task))
      (asrt (. first priority) "critical")
      (let (second) (method-call s pick_next_task))
      (asrt (. second priority) "normal")
    )`);
  });

  it('dequeues high before low', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (let (t_idle) (new Task 0 (generator-fn () (yield 1)) (array) "idle" (new Set)))
      (let (t_high) (new Task 1 (generator-fn () (yield 1)) (array) "high" (new Set)))
      (method-call s schedule t_idle)
      (method-call s schedule t_high)
      (let (first) (method-call s pick_next_task))
      (asrt (. first priority) "high")
    )`);
  });
});

describe('Scheduler.emit_agc_code', () => {
  it('appends an AGCEvent to agc_codes_emitted', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (method-call s emit_agc_code "AGC-TEST" "unit test event")
      (asrt (. (. s agc_codes_emitted) length) 1)
      (asrt (. (index (. s agc_codes_emitted) 0) code)    "AGC-TEST")
      (asrt (. (index (. s agc_codes_emitted) 0) message) "unit test event")
    )`);
  });

  it('task_id is null when no current_task', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (method-call s emit_agc_code "AGC-TEST" "no task")
      (asrt (. (index (. s agc_codes_emitted) 0) task_id) null)
    )`);
  });
});

describe('Scheduler.execute_slice', () => {
  it('runs a simple generator to completion and marks task done', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (let (t) (new Task 0 (generator-fn () (return 42)) (array) "normal" (new Set)))
      (method-call s execute_slice t)
      (asrt (. t status) "done")
    )`);
  });

  it('increments total_reductions per generator step', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (let (t) (new Task 0
        (generator-fn ()
          (yield undefined)
          (yield undefined)
          (return 0))
        (array) "normal" (new Set)))
      (method-call s execute_slice t)
      ;; 3 reductions: yield, yield, return
      (asrt (. t total_reductions) 3)
    )`);
  });

  it('marks task crashed and emits AGC code on thrown error', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (let (t) (new Task 0
        (generator-fn () (throw (new Error "boom")))
        (array) "normal" (new Set)))
      (method-call s execute_slice t)
      (asrt (. t status) "crashed")
      (asrt (> (. (. s agc_codes_emitted) length) 0) true)
    )`);
  });
});

describe('Scheduler.run', () => {
  it('processes all queued tasks and stops when empty', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (let (results) (array))
      (let (make_task) (lambda ((n : number))
        (new Task n
          (generator-fn ((val : number))
            (method-call results push val)
            (return undefined))
          (array n) "normal" (new Set))))
      (let (t0) (make_task 10))
      (let (t1) (make_task 20))
      (method-call s schedule t0)
      (method-call s schedule t1)
      (method-call s run)
      (asrt (. t0 status) "done")
      (asrt (. t1 status) "done")
      (asrt (. results length) 2)
    )`);
  });
});

describe('Scheduler.check_overload', () => {
  it('emits AGC-S100 when queue length exceeds threshold', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_CORE}
      (let (s) (new Scheduler))
      (set! (. s overload_threshold_queue_length) 0)
      (set! (. s total_run_queue_length) 1)
      (method-call s check_overload)
      (asrt (. (. s agc_codes_emitted) length) 1)
      (asrt (. (index (. s agc_codes_emitted) 0) code) "AGC-S100")
    )`);
  });
});
