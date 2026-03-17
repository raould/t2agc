/**
 * Tests for runtime layer — init_runtime, spawn, send, run.
 *
 * All inline definitions are self-contained and use only validated t2lang syntax.
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
    (field (name                          : string)           "")
    (field (status                        : string)           "runnable")
    (field (gen                           : any))
    (field (budget                        : number)           100)
    (field (initial_budget                : number)           100)
    (field (mailbox                       : (type-array any)) (array))
    (field (mailbox_max                   : number)           1000)
    (field (mailbox_overflow_policy       : string)           "drop-oldest")
    (field (waiting_patterns              : any)              null)
    (field (pending_resume                : any))
    (field (history_effects               : RingBuffer))
    (field (history_exceptional           : RingBuffer))
    (field (history_critical              : RingBuffer))
    (field (created_at                    : number)           0)
    (field (total_reductions              : number)           0)
    (field (total_messages_sent           : number)           0)
    (field (total_messages_received       : number)           0)
    (field (mailbox_scan_count            : number)           0)
    (field (total_mailbox_scan_operations : number)           0)

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

const SCHEDULER_DEF = `
(class Scheduler
  (class-body
    (field (run_queues    : any))
    (field (tasks         : any))
    (field (waiting_tasks : any))
    (field (pid_counter   : number)  0)
    (field (current_task  : any)     null)
    (field (tick_count    : number)  0)
    (field (running       : boolean) false)
    (field (total_run_queue_length          : number) 0)
    (field (avg_slice_duration              : number) 0)
    (field (overload_threshold_queue_length : number) 1000)
    (field (overload_threshold_slice_ms     : number) 50)
    (field (orchestrator_history : RingBuffer))
    (field (agc_codes_emitted    : (type-array any)))
    (field (priority_order       : (type-array any)))

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
      (let (queue : (type-array any)) (index (. this run_queues) (. task priority)))
      (method-call queue push task)
      (set! (. this total_run_queue_length)
        (+ (. this total_run_queue_length) 1)))

    (method pick_next_task () (returns any)
      (let (found : any)  null)
      (let (i     : number) 0)
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
            undefined))
        (catch error
          (method-call this on_task_crashed task error)))
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

// Runtime functions written inline for tests —
// matching the structure in src/runtime.t2 but without the
// type annotations that reference null/union.

const RUNTIME_DEF = `
(fn get_global_scheduler ()
  (. (. globalThis __t2agc__) scheduler))

(fn init_runtime ()
  (let (scheduler) (new Scheduler))
  (set! (. globalThis __t2agc__)
    (object
      (scheduler scheduler)
      (protocols (new Map))
      (debug
        (object
          (list_tasks
            (fn ()
              (let (result) (array))
              (method-call (. scheduler tasks) for_each
                (lambda ((task) (pid))
                  (method-call result push
                    (object
                      (pid              pid)
                      (name             (. task name))
                      (status           (. task status))
                      (priority         (. task priority))
                      (total_reductions (. task total_reductions))))))
              result)))))))

(fn spawn ((generator_fn) (args) (priority) (capabilities))
  (let (scheduler) (get_global_scheduler))
  (let (pid)       (method-call scheduler next_pid))
  (let (task)      (new Task pid generator_fn args priority capabilities))
  (method-call (. scheduler tasks) set pid task)
  (method-call scheduler schedule task)
  (method-call (. scheduler orchestrator_history) push
    (object (type "spawn") (timestamp (method-call Date now)) (pid pid) (priority priority)))
  pid)

(fn runtime_run ()
  (let (scheduler) (get_global_scheduler))
  (method-call scheduler run))

(fn send ((target_pid) (msg))
  (let (scheduler) (get_global_scheduler))
  (let (target)    (method-call (. scheduler tasks) get target_pid))
  (if (not target)
    (begin
      (method-call scheduler emit_agc_code "AGC-M050"
        (+ "Send to non-existent pid: " target_pid))
      (return undefined))
    undefined)
  (let (mailbox_length) (. (. target mailbox) length))
  (if (>= mailbox_length (. target mailbox_max))
    (begin
      (if (= (. target mailbox_overflow_policy) "drop-oldest")
        (begin
          (method-call (. target mailbox) shift)
          (method-call (. target mailbox) push msg))
        undefined)
      (method-call scheduler emit_agc_code "AGC-M010"
        (+ "Mailbox overflow for task " target_pid)))
    (begin
      (method-call (. target mailbox) push msg)
      (method-call (. scheduler orchestrator_history) push
        (object
          (type "send") (timestamp (method-call Date now))
          (from null) (to target_pid) (message msg)))))
  (if (= (. target status) "waiting")
    (begin
      (set! (. target pending_resume) msg)
      (set! (. target status) "runnable")
      (method-call (. scheduler waiting_tasks) delete target_pid)
      (method-call scheduler schedule target))
    undefined))
`;

// ── init_runtime ──────────────────────────────────────────────────────────────

describe('init_runtime', () => {
  it('creates __t2agc__ with a scheduler on globalThis', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (asrt (not (= (. globalThis __t2agc__) undefined)) true)
      (asrt (not (= (get_global_scheduler) undefined)) true)
    )`);
  });

  it('creates a protocols Map on __t2agc__', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (asrt (. (. globalThis __t2agc__) protocols) instanceof Map)
    )`);
  });

  it('exposes a debug.list_tasks function', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (asrt (typeof (. (. (. globalThis __t2agc__) debug) list_tasks)) "function")
    )`);
  });
});

// ── spawn ─────────────────────────────────────────────────────────────────────

describe('spawn', () => {
  it('returns an integer pid', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (let (pid) (spawn (generator-fn () (return 1)) (array) "normal" (new Set)))
      (asrt (typeof pid) "number")
    )`);
  });

  it('pids are sequential starting from 0', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (let (p0) (spawn (generator-fn () (return 1)) (array) "normal" (new Set)))
      (let (p1) (spawn (generator-fn () (return 1)) (array) "normal" (new Set)))
      (asrt p0 0)
      (asrt p1 1)
    )`);
  });

  it('registers task in scheduler.tasks map', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (let (pid) (spawn (generator-fn () (return 0)) (array) "high" (new Set)))
      (let (s) (get_global_scheduler))
      (asrt (method-call (. s tasks) has pid) true)
    )`);
  });

  it('queues task under the correct priority', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (spawn (generator-fn () (return 0)) (array) "critical" (new Set))
      (let (s) (get_global_scheduler))
      (asrt (. (. (. s run_queues) critical) length) 1)
      (asrt (. (. (. s run_queues) normal) length)   0)
    )`);
  });
});

// ── send ──────────────────────────────────────────────────────────────────────

describe('send', () => {
  it('delivers a message to the target mailbox', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (let (pid) (spawn (generator-fn () (yield undefined)) (array) "normal" (new Set)))
      (send pid "hello")
      (let (s) (get_global_scheduler))
      (let (t) (method-call (. s tasks) get pid))
      (asrt (. (. t mailbox) length) 1)
      (asrt (index (. t mailbox) 0) "hello")
    )`);
  });

  it('emits AGC-M050 when target pid does not exist', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (send 9999 "oops")
      (let (s) (get_global_scheduler))
      (asrt (. (. s agc_codes_emitted) length) 1)
      (asrt (. (index (. s agc_codes_emitted) 0) code) "AGC-M050")
    )`);
  });

  it('applies drop-oldest overflow when mailbox is full', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (let (pid) (spawn (generator-fn () (yield undefined)) (array) "normal" (new Set)))
      (let (s)   (get_global_scheduler))
      (let (t)   (method-call (. s tasks) get pid))
      ;; Limit mailbox to 1 slot with drop-oldest policy
      (method-call t configure_mailbox 1 "drop-oldest")
      (send pid "first")
      (send pid "second")
      ;; "first" was dropped, "second" is now in the mailbox
      (asrt (. (. t mailbox) length) 1)
      (asrt (index (. t mailbox) 0) "second")
    )`);
  });
});

// ── runtime_run ───────────────────────────────────────────────────────────────

describe('runtime_run', () => {
  it('drives all spawned tasks to completion', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      ${AGC_EVENT_DEF}
      ${CAPABILITY_DEF}
      ${TASK_DEF}
      ${SCHEDULER_DEF}
      ${RUNTIME_DEF}
      (init_runtime)
      (let (results) (array))
      (spawn
        (generator-fn () (method-call results push 1) (return undefined))
        (array) "normal" (new Set))
      (spawn
        (generator-fn () (method-call results push 2) (return undefined))
        (array) "normal" (new Set))
      (runtime_run)
      (let (s) (get_global_scheduler))
      (asrt (. results length) 2)
      (let (t0) (method-call (. s tasks) get 0))
      (let (t1) (method-call (. s tasks) get 1))
      (asrt (. t0 status) "done")
      (asrt (. t1 status) "done")
    )`);
  });
});
