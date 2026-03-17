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
        (then (set! (. this count) (+ (. this count) 1)))))
    (method to_array () (returns (type-array any))
      (if (< (. this count) (. this size))
        (then (return (method-call (. this buffer) slice 0 (. this count))))
        (else (return (method-call
          (method-call (. this buffer) slice (. this write_index))
          concat
          (method-call (. this buffer) slice 0 (. this write_index)))))))))
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
      ((public cap_type   : string)
       (public operations : (type-array string))
       (public metadata   : any))
      (set! (. this id) (method-call (. globalThis crypto) randomUUID)))
    (method can_perform ((operation : string)) (returns boolean)
      (return (method-call (. this operations) includes operation)))))
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
        (|| (. gen_fn name) (+ "task-" (String id)))))
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

const SCHEDULER_CORE = `(program
;; Layer 3 — Scheduler: the cooperative execution engine.
;; Depends on: Task (task.t2), AGCEvent (agc_event.t2),
;;             RingBuffer (ring_buffer.t2), Capability (capability.t2),
;;             match_pattern / compute_match_result (match_pattern.t2),
;;             Priority / TaskStatus (types.t2)
;;
;; Design note on generator resumption
;; ─────────────────────────────────────
;; execute_slice drives each task via a loop:
;;   resume_val = task.pending_resume (cleared before loop)
;;   loop: step = gen.next(resume_val)
;;         resume_val = handle_primitive(step.value)   <- may be undefined
;;
;; handle_receive / handle_selective_receive RETURN the resume value
;; (message or match_result object) instead of calling gen.next directly.
;; For the async wake-up path (send -> schedule), send() sets
;; task.pending_resume so that the next execute_slice picks it up.

(class Scheduler
  (class-body
    (field (run_queues                      : any))
    (field (tasks                           : any))
    (field (waiting_tasks                   : any))
    (field (pid_counter                     : number)           0)
    (field (current_task                    : any)                  null)
    (field (tick_count                      : number)           0)
    (field (running                         : boolean)          false)
    (field (total_run_queue_length          : number)           0)
    (field (avg_slice_duration              : number)           0)
    (field (overload_threshold_queue_length : number)           1000)
    (field (overload_threshold_slice_ms     : number)           50)
    (field (orchestrator_history            : RingBuffer))
    (field (agc_codes_emitted              : (type-array any)))
    (field (priority_order                  : (type-array any)))
    (field (monitoring_callback             : any)                  null)

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

    ;; ── PID allocation ────────────────────────────────────────────────────

    (method next_pid () (returns number)
      (let (pid : number) (. this pid_counter))
      (set! (. this pid_counter) (+ (. this pid_counter) 1))
      (return pid))

    ;; ── Queue management ──────────────────────────────────────────────────

    (method schedule ((task : any)) (returns void)
      "Enqueue task into its priority run queue."
      (let (priority : string)  (. task priority))
      (let (queue : (type-array any)) (index (. this run_queues) priority))
      (method-call queue push task)
      (set! (. this total_run_queue_length)
        (+ (. this total_run_queue_length) 1)))

    (method pick_next_task () (returns any)
      "Dequeue the highest-priority runnable task."
      (let (found : any) null)
      (let (i : number) 0)
      (while (&& (! found) (< i (. (. this priority_order) length)))
        (let (priority : string) (index (. this priority_order) i))
        (let (queue : (type-array any)) (index (. this run_queues) priority))
        (if (> (. queue length) 0)
          (then
            (set! (. this total_run_queue_length)
              (- (. this total_run_queue_length) 1))
            (set! found (method-call queue shift))))
        (set! i (+ i 1)))
      (return found))

    ;; ── Execution ─────────────────────────────────────────────────────────

    (method execute_slice ((task : any)) (returns void)
      "Run one slice of a task (up to budget reductions)."
      (set! (. this current_task) task)
      (set! (. task budget) (. task initial_budget))

      ;; Consume any pending resume value left by send() or a prior slice
      (let (resume_val : any) (. task pending_resume))
      (set! (. task pending_resume) undefined)

      (let (start_time : number) (method-call Date now))

      (try
          (while (&& (> (. task budget) 0) (== (. task status) "runnable"))
          (let (step : any) (method-call (. task gen) next resume_val))
          (set! resume_val undefined)
          (set! (. task budget) (- (. task budget) 1))
          (set! (. task total_reductions) (+ (. task total_reductions) 1))

          (if (. step done)
            (then
              (set! (. task status) "done")
              (method-call this on_task_completed task))
            (else (set! resume_val
              (method-call this handle_primitive task (. step value))))))

        (catch error
          (method-call this on_task_crashed task error)))

      (let (duration : number) (- (method-call Date now) start_time))
      (method-call this record_slice_duration duration)

      ;; Re-queue if still runnable (budget exhausted)
      (if (== (. task status) "runnable")
        (then (method-call this schedule task)))

      (set! (. this current_task) null))

    (method handle_primitive ((task : any) (primitive : any)) (returns any)
      "Dispatch a yielded primitive; return the resume value for the next gen.next()."
      (match primitive
        ((object (type "yield"))
          undefined)

        ((object (type "receive") (patterns patterns))
          (method-call this handle_receive task patterns))

        ((object (type "effect") (capability cap) (operation op) (args args))
          (method-call this handle_effect task cap op args))

        (_
          (method-call this crash_unknown_primitive task primitive))))

    (method crash_unknown_primitive ((task : any) (primitive : any)) (returns any)
      "Emit an AGC error code and mark task as crashed; returns undefined."
      (method-call this emit_agc_code "AGC-S999"
        (+ "Unknown primitive: " (method-call JSON stringify primitive)))
      (set! (. task status) "crashed")
      undefined)

    ;; ── Main loop ─────────────────────────────────────────────────────────

    (method run () (returns void)
      "Synchronous scheduler loop — runs until all tasks complete or block."
      (set! (. this running) true)
      (while (. this running)
        (set! (. this tick_count) (+ (. this tick_count) 1))
        (method-call this check_overload)
        (let (task : any) (method-call this pick_next_task))
        (if task
          (then (method-call this execute_slice task))
          (else (if (== (method-call (. this waiting_tasks) size) 0)
            (then (set! (. this running) false))
            ;; Only waiting tasks remain — yield control to event loop
            ;; TODO: in async context use setImmediate/setTimeout
            (else (set! (. this running) false)))))))

    ;; ── Overload detection ────────────────────────────────────────────────

    (method check_overload () (returns void)
      (if (> (. this total_run_queue_length) (. this overload_threshold_queue_length))
        (then (method-call this emit_agc_code "AGC-S100"
          (+ "Overload: run queue length " (. this total_run_queue_length)))))
      (if (> (. this avg_slice_duration) (. this overload_threshold_slice_ms))
        (then (method-call this emit_agc_code "AGC-S100"
          (+ "Overload: avg slice duration " (. this avg_slice_duration) "ms")))))

    (method record_slice_duration ((duration : number)) (returns void)
      (let (alpha : number) 0.1)
      (set! (. this avg_slice_duration)
        (+ (* alpha duration) (* (- 1 alpha) (. this avg_slice_duration)))))

    ;; ── Task lifecycle callbacks ───────────────────────────────────────────

    (method on_task_completed ((task : any)) (returns void)
      (method-call (. this orchestrator_history) push
        (object
          (type      "task_completed")
          (timestamp (method-call Date now))
          (pid       (. task id)))))

    (method on_task_crashed ((task : any) (error : any)) (returns void)
      (set! (. task status) "crashed")
      (method-call this emit_agc_code "AGC-S999"
        (+ "Task " (. task id) " crashed: " (. error message)))
      (method-call task record_exceptional "crashed"
        (object (error (. error message)))))

    ;; ── Messaging primitives ──────────────────────────────────────────────

    (method handle_receive ((task : any) (patterns : any)) (returns any)
      "Handle a 'receive' primitive.  Returns the resume value, or undefined
       if the task was blocked (in which case task.status = 'waiting')."
      (if (> (. (. task mailbox) length) 0)
        (then
          (if patterns
            (then (return (method-call this handle_selective_receive task patterns)))
            (else
              (let (msg : any) (method-call (. task mailbox) shift))
              (set! (. task total_messages_received)
                (+ (. task total_messages_received) 1))
              (return msg))))
        (else
          (set! (. task status)           "waiting")
          (set! (. task waiting_patterns) patterns)
          (method-call (. (. this waiting_tasks) set) call (. this waiting_tasks) (. task id) task)
          (method-call task record_exceptional "blocked_on_receive" (object))
          (return undefined))))

    (method handle_selective_receive ((task : any) (patterns : (type-array any))) (returns any)
      "Scan mailbox for first matching pattern within reduction budget.
       Returns match_result object on success, or undefined if blocked / budget exceeded."
      (set! (. task mailbox_scan_count)
        (+ (. task mailbox_scan_count) 1))

      (let (mailbox    : (type-array any)) (. task mailbox))
      (let (scan_count : number)      0)
      (let (matched    : any) null)
      (let (msg_index  : number) 0)

      (while (&& (! matched) (< msg_index (. mailbox length)))
        (let (msg : any) (index mailbox msg_index))
        (set! scan_count (+ scan_count 1))
        (set! (. task total_mailbox_scan_operations)
          (+ (. task total_mailbox_scan_operations) 1))

        (if (>= scan_count (. task budget))
          (then
            (method-call task record_exceptional "mailbox_scan_budget_exceeded"
              (object (scanned scan_count) (remaining (- (. mailbox length) msg_index))))
            (set! (. task budget) 0)
            (set! msg_index (. mailbox length)))) ;; break loop

        (let (pattern_index : number) 0)
        (while (&& (! matched) (< pattern_index (. patterns length)))
          (let (ps       : any)                (index patterns pattern_index))
          (let (bindings : any) (match_pattern (. ps pattern) msg (object)))
          (if bindings
            (then
              ;; Match found — remove message from mailbox
              (method-call mailbox splice msg_index 1)
              (set! (. task total_messages_received)
                (+ (. task total_messages_received) 1))
              (method-call task record_exceptional "received_message"
                (object
                  (message          msg)
                  (pattern_index    pattern_index)
                  (mailbox_position msg_index)))
              (set! matched
                (object
                  (matched_pattern_index pattern_index)
                  (message               msg)
                  (bindings              bindings)))))
          (set! pattern_index (+ pattern_index 1)))

        (if (! matched)
          (then (set! msg_index (+ msg_index 1)))))  ;; close while

      (if matched
        (then (return matched))
        ;; No pattern matched — block task
        (else
          (set! (. task status)           "waiting")
          (set! (. task waiting_patterns) patterns)
          (method-call (. (. this waiting_tasks) set) call (. this waiting_tasks) (. task id) task)
          (method-call task record_exceptional "blocked_on_selective_receive"
            (object
              (patterns_count (. patterns length))
              (mailbox_size   (. mailbox length))))
          (return undefined))))

    ;; ── Mailbox health monitoring ─────────────────────────────────────────

    (method check_mailbox_health ((task : any)) (returns void)
      ;; AGC-M020: slow consumer
      (if (> (. (. task mailbox) length) (* (. task mailbox_max) 0.75))
        (then (method-call this emit_agc_code "AGC-M020"
          (+ "Slow consumer: task " (. task id)
             " mailbox at " (. (. task mailbox) length) " messages"))))
      ;; AGC-M031: message stuck too long
      (if (> (. (. task mailbox) length) 0)
        (then
          (let (oldest_msg : any) (index (. task mailbox) 0))
          (if (. oldest_msg timestamp)
            (then
              (let (age : number) (- (method-call Date now) (. oldest_msg timestamp)))
              (if (> age 5000)
                (then (method-call this emit_agc_code "AGC-M031"
                  (+ "Message stuck for " age "ms in task " (. task id)))))))))
      ;; AGC-M040: excessive mailbox scanning
      (if (> (. task mailbox_scan_count) 100)
        (then
          (let (avg_scan_ops : number)
            (/ (. task total_mailbox_scan_operations) (. task mailbox_scan_count)))
          (if (> avg_scan_ops 50)
            (then (method-call this emit_agc_code "AGC-M040"
              (+ "Excessive mailbox scanning: task " (. task id)
                 " avg " avg_scan_ops " ops per scan")))))))

    ;; ── Capabilities & effects ────────────────────────────────────────────

    (method handle_effect
        ((task       : any)
         (capability : any)
         (operation  : string)
         (args       : (type-array any))) (returns any)
      "Verify capability and dispatch effect; return result as generator resume value."

      ;; 1. Verify task holds the capability
      (if (! (method-call (. task capabilities) has capability))
        (then
          (method-call this emit_agc_code "AGC-CAP500"
            (+ "Task " (. task id) " attempted effect without capability"))
          (set! (. task status) "crashed")
          (method-call task record_critical "AGC-CAP500" "Unauthorized capability usage")
          (return undefined)))

      ;; 2. Verify capability allows this operation
      (if (! (method-call capability can_perform operation))
        (then
          (method-call this emit_agc_code "AGC-CAP510"
            (+ "Capability " (. capability cap_type) " does not support operation " operation))
          (set! (. task status) "crashed")
          (return undefined)))

      ;; 3. Record effect in task history
      (method-call task record_effect capability operation args)

      ;; 4. Dispatch with latency tracking
      (let (start_time : number) (method-call Date now))
      (let (result : any) undefined)

      (try
        (set! result (method-call this dispatch_effect capability operation args))
        (catch error
          (method-call this emit_agc_code "AGC-E001"
            (+ "Effect failed: " (. error message)))
          (method-call task record_exceptional "effect_error"
            (object (operation operation) (error (. error message))))))

      (let (duration : number) (- (method-call Date now) start_time))
      (if (> duration 100)
        (then (method-call this emit_agc_code "AGC-E050"
          (+ "Slow effect: " operation " took " duration "ms"))))

      result)

    (method dispatch_effect
        ((capability : any)
         (operation  : string)
         (args       : (type-array any))) (returns any)
      "Route effect to the appropriate handler method."
      (switch (. capability cap_type)
        (case "log"         (method-call this effect_log    operation args))
        (case "io"          (method-call this effect_io     operation args capability))
        (case "timer"       (method-call this effect_timer  operation args))
        (case "random"      (method-call this effect_random operation args))
        (default
          (throw (new Error (+ "Unknown capability type: " (. capability cap_type)))))))

    (method effect_log ((operation : string) (args : (type-array any))) (returns void)
      (let (prefix : string) (+ "[" (method-call operation toUpperCase) "]"))
      (switch operation
        (case "info"  (method-call (. console log)   apply console (method-call (array prefix) concat args)))
        (case "warn"  (method-call (. console warn)  apply console (method-call (array prefix) concat args)))
        (case "error" (method-call (. console error) apply console (method-call (array prefix) concat args)))
        (case "debug" (method-call (. console debug) apply console (method-call (array prefix) concat args)))))

    (method effect_io
        ((operation  : string)
         (args       : (type-array any))
         (capability : any)) (returns any)
      (switch operation
        (case "fetch"
          (let (url : string) (index args 0))
          (if (&& (. (. capability metadata) allowedHosts)
                   (> (. (. (. capability metadata) allowedHosts) length) 0))
            (then
              (let (host : string) (extract_host url))
              (if (! (method-call (. (. capability metadata) allowedHosts) includes host))
                (then (throw (new Error (+ "Host not allowed: " host)))))))
          (await (fetch url)))
        (case "read"
          (let (path : string) (index args 0))
          (throw (new Error "effect_io 'read' not yet implemented")))
        (case "write"
          (let (path : string) (index args 0))
          (let (data : any)   (index args 1))
          (throw (new Error "effect_io 'write' not yet implemented")))))

    (method effect_timer ((operation : string) (args : (type-array any))) (returns any)
      (switch operation
        (case "sleep"
          (let (ms : number) (index args 0))
          ;; TODO: suspend task and resume after timeout (requires async scheduler)
          (throw (new Error "effect_timer 'sleep' requires async scheduler")))
        (case "set_timeout"
          (let (callback : any) (index args 0))
          (let (ms       : number)   (index args 1))
          (setTimeout callback ms))
        (case "set_interval"
          (let (callback : any) (index args 0))
          (let (ms       : number)   (index args 1))
          (setInterval callback ms))))

    (method effect_random ((operation : string) (args : (type-array any))) (returns any)
      (switch operation
        (case "next"
          (method-call Math random))
        (case "next_int"
          (let (max : number) (index args 0))
          (method-call Math floor (* (method-call Math random) max)))
        (case "next_float"
          (let (min : number) (index args 0))
          (let (max : number) (index args 1))
          (+ min (* (method-call Math random) (- max min))))))

    ;; ── AGC code emission ─────────────────────────────────────────────────

    (method emit_agc_code ((code : string) (message : string)) (returns void)
      "Emit a diagnostic event to all channels."
      (let (event : AGCEvent)
        (new AGCEvent
          code
          message
          (method-call Date now)
          (ternary (. this current_task) (. (. this current_task) id) null)
          (object)))

      (method-call (. this agc_codes_emitted) push event)
      (method-call (. this orchestrator_history) push event)

      (if (. this current_task)
        (then (method-call (. this current_task) record_critical code message)))

      (method-call console error (+ "[" code "] " message))

      (if (. this monitoring_callback)
        (then (method-call (. this monitoring_callback) call null event))))))))  ;; class-body, class

)
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
