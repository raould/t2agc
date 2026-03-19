# Implementation Plan: t2-agc

This document outlines the staged implementation plan for the `t2-agc` runtime, using `t2lang`. The goal is to build a tiny, deterministic, cooperative actor runtime inspired by the Apollo Guidance Computer.

## Implementation Order

- Key non-obvious ordering constraints:
    - Capability must precede Task (constructor takes (Set Capability))
    - RingBuffer and AGCEvent must both precede Scheduler (fields of Scheduler)
    - __t2agc__ global must precede defmacro defprotocol (it writes into __t2agc__.protocols)
    - try_match_patterns must precede send's wake-up logic (called in the wake-on-send path)
    - defmacro task must precede defmacro behavior and defmacro spawn_task
- Layer 0 — Pure type aliases (no dependencies)
    - Priority
    - TaskStatus
    - MailboxOverflowPolicy
    - CapabilityType
    - RestartPolicy, ChildType (OTP)
- Layer 1 — Foundational classes (depend only on primitives / Layer 0)
    - RingBuffer — no type dependencies; needed by Task and Scheduler
    - AGCEvent — fields are all primitives; needed by Scheduler
    - Capability — depends on CapabilityType; needed by Task
    - match_pattern — pure function, no class dependencies
- Layer 2 — Core data model
    - Task — depends on Priority, TaskStatus, MailboxOverflowPolicy, RingBuffer, Capability
- Layer 3 — Execution engine
    - Scheduler — depends on Task, AGCEvent, RingBuffer, Priority; includes all its methods (schedule, pick_next_task, execute_slice, handle_primitive, run, handle_receive, handle_selective_receive, handle_effect, dispatch_effect, effect_*, check_overload, check_mailbox_health, emit_agc_code)
    - try_match_patterns — depends on match_pattern
- Layer 4 — Runtime primitives (depend on Scheduler + Task)
    - __t2agc__ global initialisation — wraps the Scheduler singleton; needed by protocol registry and debug API
    - spawn — depends on Scheduler, Task, Capability, Priority
    - run — depends on Scheduler
    - send — depends on Scheduler, Task
    - receive (basic blocking) — depends on scheduler's handle_receive
    - effect — depends on Capability, Scheduler, Task
- Layer 5 — Macros (depend on Layer 4 runtime being in place)
    - defmacro receive — expands to yield + switch; depends on handle_selective_receive
    - defmacro task — depends on spawn, generator-fn
    - defmacro defprotocol — depends on __t2agc__ global
    - defmacro defopaque — pure structural macro, no runtime deps
    - defmacro spawn_task — depends on spawn + task macro
- Layer 6 — OTP (depend on all of the above)
    - ChildSpec interface — depends on RestartPolicy, ChildType, Priority, Capability
    - restart_child — depends on spawn, ChildSpec
    - Registry task — depends on task macro, send, receive, Map
    - defmacro behavior — depends on defprotocol, task macro, spawn

---

## 📅 Stage 1: The Kernel (Scheduler & Tasks)
**Goal:** Establish the execution loop, task structure, and cooperative yielding.

### 1.1 Data Structures

#### 1.1.1 Task Structure (Complete Specification)

The `Task` class represents a single cooperative execution unit. Must include ALL fields from DESIGN.md:

```t2
;; Type definitions for Task
(export (type Priority (tlit "critical") (tlit "high") (tlit "normal") (tlit "low") (tlit "idle")))
(export (type TaskStatus (tlit "runnable") (tlit "waiting") (tlit "done") (tlit "crashed")))
(export (type MailboxOverflowPolicy (tlit "drop-oldest") (tlit "drop-newest") (tlit "reject") (tlit "escalate") (tlit "block-sender")))

(class Task
  (class-body
    ;; Fields with defaults — not set via constructor shorthand
    (field (name                          : string)                    "")
    (field (status                        : TaskStatus)                "runnable")
    (field (gen                           : Generator))
    (field (budget                        : number)                    100)
    (field (initial_budget                : number)                    100)
    (field (mailbox                       : (Array any))               (array))
    (field (mailbox_max                   : number)                    1000)
    (field (mailbox_overflow_policy       : MailboxOverflowPolicy)     "drop-oldest")
    (field (waiting_patterns              : (union (Array any) null))  null)
    (field (history_effects               : RingBuffer))
    (field (history_exceptional           : RingBuffer))
    (field (history_critical              : RingBuffer))
    (field (created_at                    : number)                    0)
    (field (total_reductions              : number)                    0)
    (field (total_messages_sent           : number)                    0)
    (field (total_messages_received       : number)                    0)
    (field (mailbox_scan_count            : number)                    0)
    (field (total_mailbox_scan_operations : number)                    0)

    ;; Constructor — id, priority, capabilities use field shorthand
    (constructor
      ((public id           : number)
       (gen_fn              : Function)
       (args                : (Array any))
       (public priority     : Priority)
       (public capabilities : (Set Capability)))
      (set! (. this name)                (or (. gen_fn name) (+ "task-" (string id))))
      (set! (. this gen)                 (apply gen_fn args))
      (set! (. this history_effects)     (new RingBuffer 100))
      (set! (. this history_exceptional) (new RingBuffer 50))
      (set! (. this history_critical)    (new RingBuffer 20))
      (set! (. this created_at)          (timestamp)))))
```

**JavaScript Implementation:**
```javascript
class Task {
  constructor(id, generatorFn, args, priority = 'normal', capabilities = new Set()) {
    this.id = id;
    this.name = generatorFn.name || `task-${id}`;
    this.priority = priority;
    this.status = 'runnable';
    this.gen = generatorFn(...args);
    this.budget = 100;
    this.initialBudget = 100;
    
    this.mailbox = [];
    this.mailboxMax = 1000;
    this.mailboxOverflowPolicy = 'drop-oldest';
    this.waitingPatterns = null;
    
    this.capabilities = capabilities;
    
    this.historyEffects = new RingBuffer(100);
    this.historyExceptional = new RingBuffer(50);
    this.historyCritical = new RingBuffer(20);
    
    this.createdAt = Date.now();
    this.totalReductions = 0;
    this.totalMessagesSent = 0;
    this.totalMessagesReceived = 0;
    this.mailboxScanCount = 0;
    this.totalMailboxScanOperations = 0;
  }
  
  // Configure mailbox behavior
  configureMailbox(maxSize, overflowPolicy) {
    this.mailboxMax = maxSize;
    this.mailboxOverflowPolicy = overflowPolicy;
  }
  
  // Record event to appropriate history
  recordEffect(capability, operation, args) {
    this.historyEffects.push({
      timestamp: Date.now(),
      capability: capability.id,
      operation,
      args
    });
  }
  
  recordExceptional(eventType, data) {
    this.historyExceptional.push({
      timestamp: Date.now(),
      type: eventType,
      data
    });
  }
  
  recordCritical(agcCode, message) {
    this.historyCritical.push({
      timestamp: Date.now(),
      code: agcCode,
      message
    });
  }
}
```

#### 1.1.2 Ring Buffer Utility

```javascript
class RingBuffer {
  constructor(size) {
    this.size = size;
    this.buffer = new Array(size);
    this.index = 0;
    this.count = 0;
  }
  
  push(item) {
    this.buffer[this.index] = item;
    this.index = (this.index + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  
  toArray() {
    if (this.count < this.size) {
      return this.buffer.slice(0, this.count);
    }
    // Reconstruct in chronological order
    return [
      ...this.buffer.slice(this.index),
      ...this.buffer.slice(0, this.index)
    ];
  }
}
```

### 1.2 The Scheduler

#### 1.2.1 Complete Scheduler Structure

The Scheduler manages task lifecycle, priority_based scheduling, and system overload detection.

```t2
(class Scheduler
  (class-body
  ;; Fields
  (field (run_queues                    : object))            ; Priority → (Array Task)
  (field (tasks                         : (Map number Task)))
  (field (waiting_tasks                 : (Map number Task)))
  (field (pid_counter                   : number)             0)
  (field (current_task                  : (union Task null))  null)
  (field (tick_count                    : number)             0)
  (field (running                       : boolean)            false)
  (field (total_run_queue_length        : number)             0)
  (field (avg_slice_duration            : number)             0)
  (field (slice_duration_samples        : (Array number)))
  (field (overload_threshold_queue_length : number)           1000)
  (field (overload_threshold_slice_ms   : number)             50)
  (field (orchestrator_history          : RingBuffer))
  (field (agc_codes_emitted             : (Array AGCEvent)))
  (field (priority_order                : (Array string)))

  ;; Constructor — no params; all state initialized here
  (constructor ()
    (set! (. this run_queues)
      (object
        (critical (array))
        (high     (array))
        (normal   (array))
        (low      (array))
        (idle     (array))))
    (set! (. this tasks)                    (new Map))
    (set! (. this waiting_tasks)            (new Map))
    (set! (. this slice_duration_samples)   (array))
    (set! (. this orchestrator_history)     (new RingBuffer 200))
    (set! (. this agc_codes_emitted)        (array))
    (set! (. this priority_order)           (array "critical" "high" "normal" "low" "idle")))

  (method schedule ((task : Task)) (returns void)
    "Add task to appropriate run queue"
    (let (priority : Priority)  (. task priority))
    (let (queue : (Array Task)) (index (. this run_queues) priority))
    ((. queue push) task)
    (set! (. this total_run_queue_length) (+ (. this total_run_queue_length) 1)))
  
  (method pick_next_task () (returns (union Task null))
    "Select highest priority non-empty queue and dequeue task"
    (for_each (. this priority_order) (lambda ((priority : string))
      (let (queue : (Array Task)) (index (. this run_queues) priority))
      (when (> (length queue) 0)
        (set! (. this total_run_queue_length) (- (. this total_run_queue_length) 1))
        (return ((. queue shift))))))
    null)
  
  (method execute_slice ((task : Task)) (returns void)
    "Execute one slice of a task (up to budget reductions)"
    (set! (. this current_task) task)
    (set! (. task budget) (. task initial_budget))
    
    (let (start_time : number) (timestamp))
    (let (result : any) null)
    
    (try
      (while (and (> (. task budget) 0) (= (. task status) "runnable"))
        (set! result ((. (. task gen) next)))
        (set! (. task budget) (- (. task budget) 1))
        (set! (. task total_reductions) (+ (. task total_reductions) 1))
        
        (match result
          ((object (done true) (value _))
            (set! (. task status) "done")
            ((. this on_task_completed) task))
          
          ((object (done false) (value primitive))
            ((. this handle_primitive) task primitive))))
      
      (catch error
        ((. this on_task_crashed) task error)))
    
    ;; Record slice duration for overload detection
    (let (duration : number) (- (timestamp) start_time))
    ((. this record_slice_duration) duration)
    
    ;; Re-queue if still runnable
    (when (= (. task status) "runnable")
      ((. this schedule) task))
    
    (set! (. this current_task) null))
  
  (method handle_primitive ((task : Task) (primitive : object)) (returns void)
    "Handle yielded primitives from generator"
    (match primitive
      ((object (type "yield"))
        ;; Simple yield - task stays runnable
        null)
      
      ((object (type "receive") (patterns patterns))
        ;; Selective receive - may block
        ((. this handle_receive) task patterns))
      
      ((object (type "effect") (capability cap) (operation op) (args args))
        ;; Effect dispatch
        ((. this handle_effect) task cap op args))
      
      (_
        ((. this emit_agc_code) "AGC-S999" (+ "Unknown primitive: " primitive))
        (set! (. task status) "crashed"))))
  
  (method run () (returns void)
    "Main scheduler loop"
    (set! (. this running) true)
    
    (while (. this running)
      (set! (. this tick_count) (+ (. this tick_count) 1))
      
      ;; Check for overload
      ((. this check_overload))
      
      ;; Pick next task
      (let (task : (union Task null)) ((. this pick_next_task)))
      
      (if task
        ((. this execute_slice) task)
        ;; No tasks - could sleep or exit
        (if (= (length (keys (. this waiting_tasks))) 0)
          ;; No tasks at all - shut down
          (set! (. this running) false)
          ;; Only waiting tasks - could sleep briefly
          (sleep 1)))))
  
  (method check_overload () (returns void)
    "Detect system overload and emit AGC-S100 if needed"
    (when (> (. this total_run_queue_length) (. this overload_threshold_queue_length))
      ((. this emit_agc_code) "AGC-S100"
        (+ "Overload: run queue length " (. this total_run_queue_length))))
    
    (when (> (. this avg_slice_duration) (. this overload_threshold_slice_ms))
      ((. this emit_agc_code) "AGC-S100"
        (+ "Overload: avg slice duration " (. this avg_slice_duration) "ms"))))
  
  (method record_slice_duration ((duration : number)) (returns void)
    "Update EMA of slice duration"
    (let (alpha : number) 0.1)
    (set! (. this avg_slice_duration)
      (+ (* alpha duration) (* (- 1 alpha) (. this avg_slice_duration)))))
  
  (method emit_agc_code ((code : string) (message : string)) (returns void)
    "Emit an AGC diagnostic code"
    (let (event : AGCEvent)
      (object
        (timestamp (timestamp))
        (code      code)
        (message   message)
        (task_id   (if (. this current_task) (. this current_task id) null))))
    ((. (. this agc_codes_emitted) push) event)
    ((. console error) (+ "[" code "] " message))
    (when (. this current_task)
      ((. (. this current_task) recordCritical) code message))))))
```

**JavaScript Implementation Sketch:**
```javascript
class Scheduler {
  constructor() {
    this.runQueues = {
      critical: [],
      high: [],
      normal: [],
      low: [],
      idle: []
    };
    this.priorityOrder = ['critical', 'high', 'normal', 'low', 'idle'];
    
    this.tasks = new Map();
    this.waitingTasks = new Map();
    this.pidCounter = 0;
    
    this.currentTask = null;
    this.tickCount = 0;
    this.running = false;
    
    this.totalRunQueueLength = 0;
    this.avgSliceDuration = 0;
    this.overloadThresholdQueueLength = 1000;
    this.overloadThresholdSliceMs = 50;
    
    this.orchestratorHistory = new RingBuffer(200);
    this.agcCodesEmitted = [];
  }
  
  // ... methods as above
}
```

### 1.3 Primitives

#### 1.3.1 `spawn(fn, args, priority, capabilities)`

```t2
(fn spawn ((generator_fn : Function) (args : (Array any)) (priority : Priority) (capabilities : (Set Capability))) : number
  "Create and schedule a new task"
  (let (scheduler : Scheduler) (get_global_scheduler))
  (let (pid : number)          (. scheduler next_pid))
  (let (task : Task)           (new Task pid generator_fn args priority capabilities))

  ;; Register task
  ((. (. scheduler tasks) set) pid task)

  ;; Schedule task
  ((. scheduler schedule) task)

  ;; Record in orchestrator history
  ((. (. scheduler orchestrator_history) push)
    (object
      (type      "spawn")
      (timestamp (timestamp))
      (pid       pid)
      (priority  priority)))

  pid)
```

**JavaScript:**
```javascript
function spawn(generatorFn, args = [], priority = 'normal', capabilities = new Set()) {
  const scheduler = globalThis.__t2agc__.scheduler;
  const pid = scheduler.pidCounter++;
  const task = new Task(pid, generatorFn, args, priority, capabilities);
  
  scheduler.tasks.set(pid, task);
  scheduler.schedule(task);
  
  scheduler.orchestratorHistory.push({
    type: 'spawn',
    timestamp: Date.now(),
    pid,
    priority
  });
  
  return pid;
}
```

#### 1.3.2 `yield()`

```t2
;; In a generator-fn task body, yield control back to the scheduler:
;;   (yield (object (type "yield")))
;; The scheduler's handle_primitive sees (object (type "yield")) and keeps the task runnable.
```

**In practice, the generator function simply calls JavaScript `yield`.**

#### 1.3.3 `run()`

```t2
(fn run () : void
  "Start the scheduler main loop"
  (let (scheduler : Scheduler) (get_global_scheduler))
  ((. scheduler run)))
```
```

---

## 📅 Stage 2: Messaging (Send & Basic Receive)
**Goal:** Enable tasks to communicate with mailbox overflow policies and wake-up mechanisms.

### 2.1 Mailbox Configuration

Each task declares mailbox behavior via options (see Task structure in 1.1.1):

```t2
(task high_throughput_worker ()
  ("max_mailbox" 5000)
  ("on_overflow" "reject")
  ;; ... body
)
```

**Mailbox Overflow Policies (from DESIGN.md):**

1. **`"drop-oldest"`** (default) - Drop the oldest message in the mailbox when full. Safest for most actor systems.
2. **`"drop-newest"`** - Reject the incoming message when mailbox is full.
3. **`"reject"`** - Send an error message back to sender: `(array "mailbox_full" target_pid)`
4. **`"escalate"`** - Crash the task (supervisor restarts it). Use for critical actors.
5. **`"block-sender"`** (optional, complex) - Sender yields until space available. (May defer to later stage.)

### 2.2 `send` Implementation

**Signature:** `(send target_pid msg)`

**Full Algorithm:**

```t2
(fn send ((target_pid : number) (msg : any)) : void
  "Send a message to a task's mailbox"
  (let (scheduler : Scheduler)         (get_global_scheduler))
  (let (sender : (union Task null))    (. scheduler current_task))

  ;; Look up target task
  (let (target : (union Task null))    ((. (. scheduler tasks) get) target_pid))
  
  (when (not target)
    ;; Target doesn't exist - emit warning
    ((. scheduler emit_agc_code) "AGC-M050"
      (+ "Send to non-existent pid: " target_pid))
    (return null))
  
  ;; Check mailbox capacity
  (let (mailbox_length : number) (length (. target mailbox)))
  
  (if (>= mailbox_length (. target mailbox_max))
    ;; Mailbox is full - apply overflow policy
    (match (. target mailbox_overflow_policy)
      ("drop-oldest"
        ((. (. target mailbox) shift))  ; Remove oldest
        ((. (. target mailbox) push) msg)
        ((. scheduler emit_agc_code) "AGC-M010"
          (+ "Mailbox overflow (drop-oldest) for task " target_pid)))
      
      ("drop-newest"
        ;; Do nothing - drop the new message
        ((. scheduler emit_agc_code) "AGC-M010"
          (+ "Mailbox overflow (drop-newest) for task " target_pid)))
      
      ("reject"
        ;; Send error back to sender
        (when sender
          ((. (. sender mailbox) push)
            (array "mailbox_full" target_pid)))
        ((. scheduler emit_agc_code) "AGC-M010"
          (+ "Mailbox overflow (reject) for task " target_pid)))
      
      ("escalate"
        ;; Crash the target task
        (set! (. target status) "crashed")
        ((. scheduler emit_agc_code) "AGC-M010"
          (+ "Mailbox overflow (escalate) - crashing task " target_pid))
        ((. target recordExceptional) "mailbox_overflow" (object (sender (if sender (. sender id) null))))))
    
    ;; Mailbox has space - append message
    (begin
      ((. (. target mailbox) push) msg)

      ;; Record in sender's stats
      (when sender
        (set! (. sender total_messages_sent)
          (+ (. sender total_messages_sent) 1)))

      ;; Record in orchestrator history
      ((. (. scheduler orchestrator_history) push)
        (object
          (type      "send")
          (timestamp (timestamp))
          (from      (if sender (. sender id) null))
          (to        target_pid)
          (message   msg)))))
  
  ;; **CRUCIAL WAKE-UP LOGIC**
  ;; If target is waiting on receive, check if new message matches
  (when (= (. target status) "waiting")
    (when (. target waiting_patterns)
      (let (matched : (union object null)) (try_match_patterns msg (. target waiting_patterns)))
      (when matched
        ;; Message matches! Wake the task up
        ((. (. scheduler waiting_tasks) delete) target_pid)
        (set! (. target status) "runnable")
        (set! (. target waiting_patterns) null)
        ((. scheduler schedule) target)
        
        ;; Record wake-up event
        ((. target recordExceptional) "woken_by_message"
          (object (sender (if sender (. sender id) null))))))))
```

**JavaScript Implementation:**
```javascript
function send(targetPid, msg) {
  const scheduler = globalThis.__t2agc__.scheduler;
  const sender = scheduler.currentTask;
  
  const target = scheduler.tasks.get(targetPid);
  if (!target) {
    scheduler.emitAGCCode('AGC-M050', `Send to non-existent pid:  ${targetPid}`);
    return;
  }
  
  const mailboxLength = target.mailbox.length;
  
  if (mailboxLength >= target.mailboxMax) {
    // Apply overflow policy
    switch (target.mailboxOverflowPolicy) {
      case 'drop-oldest':
        target.mailbox.shift();
        target.mailbox.push(msg);
        scheduler.emitAGCCode('AGC-M010', `Mailbox overflow (drop-oldest) for task ${targetPid}`);
        break;
      case 'drop-newest':
        scheduler.emitAGCCode('AGC-M010', `Mailbox overflow (drop-newest) for task ${targetPid}`);
        break;
      case 'reject':
        if (sender) {
          sender.mailbox.push({ tag:  'mailbox_full', targetPid });
        }
        scheduler.emitAGCCode('AGC-M010', `Mailbox overflow (reject) for task ${targetPid}`);
        break;
      case 'escalate':
        target.status = 'crashed';
        scheduler.emitAGCCode('AGC-M010', `Mailbox overflow (escalate) - crashing task ${targetPid}`);
        target.recordExceptional('mailbox_overflow', { sender:  sender?.id });
        break;
    }
  } else {
    // Append message
    target.mailbox.push(msg);
    
    if (sender) {
      sender.totalMessagesSent++;
    }
    
    scheduler.orchestratorHistory.push({
      type: 'send',
      timestamp: Date.now(),
      from: sender?.id,
      to: targetPid,
      message: msg
    });
  }
  
  // Wake up target if waiting and message matches
  if (target.status === 'waiting' && target.waitingPatterns) {
    const matched = tryMatchPatterns(msg, target.waitingPatterns);
    if (matched) {
      scheduler.waitingTasks.delete(targetPid);
      target.status = 'runnable';
      target.waitingPatterns = null;
      scheduler.schedule(target);
      
      target.recordExceptional('woken_by_message', { sender:  sender?.id });
    }
  }
}
```

### 2.3 `receive` (Basic Blocking Version)

**Note:** This is the *simple* version. Stage 3 covers selective receive with pattern matching.

For basic receive (just pop the first message):

```t2
(fn receive () : any
  "Block until a message arrives, then return it.
   Call inside a generator-fn task body; the scheduler resumes with the message."
  (yield (object (type "receive") (patterns null))))
```

**Scheduler handling of `"receive"` primitive:**

```t2
(method handle_receive ((task : Task) (patterns : (union (Array any) null))) (returns void)
  "Handle receive primitive - may block task"

  (if (> (length (. task mailbox)) 0)
    ;; Mailbox not empty
    (if patterns
      ;; Selective receive (Stage 3)
      ((. this handle_selective_receive) task patterns)
      ;; Simple receive - pop first message
      (let (msg : any) ((. (. task mailbox) shift)))
      (set! (. task total_messages_received) (+ (. task total_messages_received) 1))
      ;; Resume generator with message
      (set! (. task gen) ((. (. task gen) next) msg)))

    ;; Mailbox empty - block task
    (begin
      (set! (. task status) "waiting")
      (set! (. task waiting_patterns) patterns)
      ((. (. this waiting_tasks) set) (. task id) task)

      ;; Emit warning if task has been waiting too long
      ;; (this would be checked periodically by scheduler)
      ((. task recordExceptional) "blocked_on_receive" (object)))))
```

**JavaScript Implementation:**
```javascript
handleReceive(task, patterns) {
  if (task.mailbox.length > 0) {
    if (patterns) {
      // Selective receive (Stage 3)
      return this.handleSelectiveReceive(task, patterns);
    } else {
      // Simple receive
      const msg = task.mailbox.shift();
      task.totalMessagesReceived++;
      
      // Resume generator with the message
      const result = task.gen.next(msg);
      // Continue processing...
    }
  } else {
    // Block task
    task.status = 'waiting';
    task.waitingPatterns = patterns;
    this.waitingTasks.set(task.id, task);
    
    task.recordExceptional('blocked_on_receive', {});
  }
}
```

### 2.4 Mailbox Monitoring & AGC Codes

The scheduler should periodically check for mailbox pathologies:

```t2
(method check_mailbox_health ((task : Task)) (returns void)
  "Emit AGC codes for mailbox issues"

  ;; AGC-M020: Slow consumer (mailbox growing)
  (when (> (length (. task mailbox)) (* (. task mailbox_max) 0.75))
    ((. this emit_agc_code) "AGC-M020"
      (+ "Slow consumer: task " (. task id) " mailbox at "
              (length (. task mailbox)) " messages")))

  ;; AGC-M030: Unhandled messages (message stuck too long)
  (when (> (length (. task mailbox)) 0)
    (let (oldest_msg : any) (index (. task mailbox) 0))
    (when (. oldest_msg timestamp)
      (let (age : number) (- (timestamp) (. oldest_msg timestamp)))
      (when (> age 5000)  ; 5 seconds
        ((. this emit_agc_code) "AGC-M031"
          (+ "Message stuck for " age "ms in task " (. task id))))))
  
  ;; AGC-M040: Excessive mailbox scanning
  (when (> (. task mailbox_scan_count) 100)
    (let (avg_scan_ops : number) (/ (. task total_mailbox_scan_operations) 
                         (. task mailbox_scan_count)))
    (when (> avg_scan_ops 50)
      ((. this emit_agc_code) "AGC-M040"
        (+ "Excessive mailbox scanning: task " (. task id)
                " avg " avg_scan_ops " ops per scan"))))
)
```

---

## 📅 Stage 3: Selective Receive
**Goal:** The heart of the actor model — scanning the mailbox for pattern matches.

### 3.1 The Challenge

Selective receive is NOT a simple FIFO pop. It allows the task to:
1. Scan its entire mailbox (within reduction budget)
2. Match messages against multiple patterns in order
3. Remove and consume only the FIRST matching message
4. Leave unmatched messages in the mailbox for later

This is fundamentally different from basic message passing and is what makes Erlang-style actors powerful.

### 3.2 Pattern Matching Fundamentals

Before implementing selective receive, we need pattern matching.

**Pattern Types:**
```t2
;; Literal patterns
"ok"                    ; Matches exactly the string "ok"

;; Tagged tuple patterns (arrays with string tags)
(array "get" from)              ; Matches (array "get" <any>), binds second element to 'from'
(array "user_data" name age)    ; Matches (array "user_data" <any> <any>), binds both

;; Nested patterns
(array "result" (array "ok" value))    ; Matches nested structure

;; Wildcards
_                        ; Matches anything, doesn't bind

;; Guards (optional, advanced)
(array "count" n) when (> n 0)  ; Matches if guard succeeds
```

**Pattern Matching Algorithm:**

```t2
(fn match_pattern ((pattern : any) (value : any) (bindings : object)) : (union object null)
  "Attempt to match pattern against value. Returns bindings map or null."
  
  (cond
    ;; Wildcard - always matches
    ((= pattern "_")
      bindings)
    
    ;; Symbol binding - matches anything, binds value
    ((== (typeof pattern) "symbol")
      ((. bindings set) pattern value)
      bindings)
    
    ;; Literal match (number or string)
    ((or (== (typeof pattern) "number") (== (typeof pattern) "string"))
      (if (= pattern value)
        bindings
        null))
    
    ;; Tuple/Array pattern
    (((. Array isArray) pattern)
      (if (and ((. Array isArray) value) (= (length pattern) (length value)))
        ;; Recursively match each element
        (reduce
          (lambda (acc i)
            (if (not acc)
              null
              (match_pattern (index pattern i) (index value i) acc)))
          bindings
          (range 0 (length pattern)))
        null))
    
    ;; No match
    (true null)))
```

**JavaScript Implementation:**
```javascript
function matchPattern(pattern, value, bindings = {}) {
  // Wildcard
  if (pattern === '_') {
    return bindings;
  }
  
  // Symbol binding (string starting with lowercase)
  if (typeof pattern === 'string' && /^[a-z]/.test(pattern)) {
    bindings[pattern] = value;
    return bindings;
  }
  
  // Literal match
  if (typeof pattern !== 'object' || pattern === null) {
    return pattern === value ? bindings : null;
  }
  
  // Array/tuple pattern
  if (Array.isArray(pattern)) {
    if (!Array.isArray(value) || pattern.length !== value.length) {
      return null;
    }
    
    let currentBindings = { ...bindings };
    for (let i = 0; i < pattern.length; i++) {
      const result = matchPattern(pattern[i], value[i], currentBindings);
      if (result === null) return null;
      currentBindings = result;
    }
    return currentBindings;
  }
  
  // Object pattern (optional)
  // ... similar logic for object matching
  
  return null;
}
```

### 3.3 Selective Receive Implementation

**The `receive` Macro:**

In t2-lang, `receive` is a macro that expands into a mailbox scanning loop:

```t2
;; User writes:
(receive
  ((array "high_priority" data) 
    (process_high data))
  ((array "low_priority" data) 
    (process_low data))
  (_ 
    (handle_unknown)))

;; Macro Definition:
(defmacro receive ((rest clauses))
  "Selective receive — scan mailbox for first matching pattern.
   Each clause is (pattern body...). Yields a 'receive' primitive to the
   scheduler and then dispatches on the matched pattern index."
  (let (patterns)
    (map clauses (lambda ((clause))
      (quasi (object (pattern ~(head clause)) (body (begin ~@(tail clause))))))))
  (quasi (begin
    (let (__receive_result)
      (yield
        (object
          (type "receive")
          (patterns (array ~@patterns)))))
    (switch (. __receive_result matched_pattern_index)
      ~@(map_indexed clauses (lambda ((i) (clause))
          (quasi (case ~i ~@(tail clause)))))))))

;; Example expansion of:
;;   (receive
;;     ((array "high_priority" data) (process_high data))
;;     ((array "low_priority" data)  (process_low data))
;;     (_ (handle_unknown)))
;; Expands to:
;;   (begin
;;     (let (__receive_result)
;;       (yield
;;         (object
;;           (type "receive")
;;           (patterns (array
;;             (object (pattern (array "high_priority" data)) (body (begin (process_high data))))
;;             (object (pattern (array "low_priority" data))  (body (begin (process_low data))))
;;             (object (pattern _)                            (body (begin (handle_unknown)))))))))
;;     (switch (. __receive_result matched_pattern_index)
;;       (case 0 (process_high data))
;;       (case 1 (process_low data))
;;       (case 2 (handle_unknown))))
```

### 3.4 Scheduler's Selective Receive Handler

**Full Algorithm with Reduction Budget:**

```t2
(method handle_selective_receive ((task : Task) (patterns : (Array any))) (returns string)
  "Scan mailbox for first matching pattern"

  ;; Track statistics
  (set! (. task mailbox_scan_count) (+ (. task mailbox_scan_count) 1))

  ;; Scan mailbox
  (let (mailbox : (Array any)) (. task mailbox))
  (let (scan_count : number)   0)
  
  (for_each-indexed mailbox (lambda ((msg : any) (index : number))
    ;; Check reduction budget
    (set! scan_count (+ scan_count 1))
    (set! (. task total_mailbox_scan_operations) 
          (+ (. task total_mailbox_scan_operations) 1))
    
    (when (>= scan_count (. task budget))
      ;; Exceeded budget - must yield and continue later
      ((. task recordExceptional) "mailbox_scan_budget_exceeded"
        (object (scanned scan_count) (remaining (- (length mailbox) index))))
      (set! (. task budget) 0)
      (return "budget_exceeded"))
    
    ;; Try each pattern in order
    (for_each patterns (lambda ((pattern_spec : any))
      (let (bindings : (union object null)) (match_pattern (. pattern_spec pattern) msg (object)))

      (when bindings
        ;; Match found! Remove message from mailbox
        (array_remove_at! mailbox index)
        (set! (. task total_messages_received)
              (+ (. task total_messages_received) 1))

        ;; Record in task history
        ((. task recordExceptional) "received_message"
          (object
            (message         msg)
            (pattern_index   (indexOf patterns pattern_spec))
            (mailbox_position index)))

        ;; Resume generator with match result
        (let (match_result : object)
          (object
            (matched_pattern_index (indexOf patterns pattern_spec))
            (message  msg)
            (bindings bindings)))
        (set! (. task gen) ((. (. task gen) next) match_result))
        
        (return "matched"))))
    
    ;; No pattern matched this message, continue to next
    null))
  
  ;; If we get here, no message matched any pattern
  (when (not= scan_count "budget_exceeded")
    ;; Block task until new message arrives
    (set! (. task status) "waiting")
    (set! (. task waiting_patterns) patterns)
    ((. (. this waiting_tasks) set) (. task id) task)

    ((. task recordExceptional) "blocked_on_selective_receive"
      (object
        (patterns_count (length patterns))
        (mailbox_size   (length mailbox))))))
```

**JavaScript Implementation:**
```javascript
handleSelectiveReceive(task, patterns) {
  task.mailboxScanCount++;
  
  const mailbox = task.mailbox;
  let scanCount = 0;
  
  for (let index = 0; index < mailbox.length; index++) {
    const msg = mailbox[index];
    scanCount++;
    task.totalMailboxScanOperations++;
    
    // Check reduction budget
    if (scanCount >= task.budget) {
      task.recordExceptional('mailbox_scan_budget_exceeded', {
        scanned: scanCount,
        remaining: mailbox.length - index
      });
      task.budget = 0;
      return 'budget_exceeded';
    }
    
    // Try each pattern in order
    for (let patternIndex = 0; patternIndex < patterns.length; patternIndex++) {
      const patternSpec = patterns[patternIndex];
      const bindings = matchPattern(patternSpec.pattern, msg);
      
      if (bindings !== null) {
        // Match found! Remove message
        mailbox.splice(index, 1);
        task.totalMessagesReceived++;
        
        task.recordExceptional('received_message', {
          message: msg,
          patternIndex,
          mailboxPosition: index
        });
        
        // Resume generator with match result
        const matchResult = {
          matchedPatternIndex: patternIndex,
          message: msg,
          bindings: bindings
        };
        
        const result = task.gen.next(matchResult);
        // Continue execution...
        return 'matched';
      }
    }
  }
  
  // No match - block task
  task.status = 'waiting';
  task.waitingPatterns = patterns;
  this.waitingTasks.set(task.id, task);
  
  task.recordExceptional('blocked_on_selective_receive', {
    patternsCount: patterns.length,
    mailboxSize: mailbox.length
  });
}
```

### 3.5 Wake-Up Refinement

Earlier in Stage 2 we showed basic wake-up logic in `send`. Now we refine it for selective receive:

```t2
(fn try_match_patterns ((msg : any) (patterns : (Array any))) : boolean
  "Check if message matches any of the waiting patterns"
  (for_each patterns (lambda ((pattern_spec : any))
    (let (bindings : (union object null)) (match_pattern (. pattern_spec pattern) msg (object)))
    (when bindings
      (return true))))
  false)
```

This is called in `send` when a task is in `"waiting"` status.

### 3.6 Example: Selective Receive in Action

**User Code:**
```t2
(task prioritizer ()
  (loop
    (receive
      ;; High priority messages processed first
      ((array "urgent" task) 
        (effect cap_log "info" "Processing urgent task")
        (process_urgent task))
      
      ;; Normal messages processed if no urgent
      ((array "normal" task)
        (effect cap_log "info" "Processing normal task")
        (process_normal task))
      
      ;; Everything else
      (msg
        (effect cap_log "warn" "Unknown message" msg)))
    
    (yield)
    (recur)))
```

**Scenario:**
1. Task has mailbox: `[(array "normal" "A") (array "urgent" "B") (array "normal" "C")]`
2. `receive` scans mailbox
3. First message `(array "normal" "A")` doesn't match first pattern `(array "urgent" task)`
4. Second message `(array "urgent" "B")` DOES match first pattern
5. Message removed at index 1, `task` bound to `"B"`
6. Mailbox now: `[(array "normal" "A") (array "normal" "C")]`
7. Next receive will get `(array "normal" "A")`

This demonstrates **selective** receive - messages are not strictly FIFO.

---

## 📅 Stage 4: Capabilities & Effects
**Goal:** Enforce safety and "authority-based" side effects.

### 4.1 Capability Structure

Capabilities are **opaque tokens** that grant authority to perform specific effects.

**Core Principle from DESIGN.md:**
> Capabilities are **never** held in a global registry. They must be:
> - Passed explicitly as arguments when a task is spawned
> - Sent via messages between tasks

**Capability Object:**
```t2
;; Type definition for Capability
(export (type CapabilityType (tlit "log") (tlit "io") (tlit "timer") (tlit "random") (tlit "shared-blob")))

(class Capability
  (class-body
    ;; id auto-generated — not a constructor param
    (field (id : string) "")

    ;; Constructor — type, operations, metadata use field shorthand
    (constructor
      ((public type       : CapabilityType)
       (public operations : (Array string))
       (public metadata   : object))
      (set! (. this id) ((. crypto randomUUID))))))
```

**JavaScript Implementation:**
```javascript
class Capability {
  constructor(type, operations = [], metadata = {}) {
    this.id = crypto.randomUUID();
    this.type = type;
    this.operations = operations;
    this.metadata = metadata;
  }
  
  canPerform(operation) {
    return this.operations.includes(operation);
  }
}

// Predefined capability constructors
function makeLogCapability() {
  return new Capability('log', ['info', 'warn', 'error', 'debug']);
}

function makeIOCapability(allowedHosts = []) {
  return new Capability('io', ['read', 'write', 'fetch'], { allowedHosts });
}

function makeTimerCapability() {
  return new Capability('timer', ['sleep', 'set_timeout', 'set_interval']);
}

function makeRandomCapability() {
  return new Capability('random', ['next', 'next_int', 'next_float']);
}
```

### 4.2 Passing Capabilities

**At Spawn Time:**
```t2
;; Parent has three capabilities
(task parent (cap_log cap_io cap_timer)
  ;; Spawn child with only log and timer capabilities
  ;; Child CANNOT perform I/O
  (let child_pid (spawn child_worker (array cap_log cap_timer) "normal"))
  
  (send child_pid (array "start"))
  (yield))

(task child_worker (cap_log cap_timer)
  (receive
    ((array "start")
      (effect cap_log "info" "Child started")
      (effect cap_timer "sleep" 1000)
      ;; child_worker does NOT have cap_io, so cannot do network I/O
      (yield))))
```

**Via Messages:**
```t2
;; Capability delegation via message passing
(task gatekeeper (cap_io)
  (receive
    ((array "grant_io_access" to_pid)
      ;; Send capability to another task
      (send to_pid (array "io_capability" cap_io))
      (yield))))

(task worker ()
  (receive
    ((array "io_capability" cap)
      ;; Worker now has I/O capability
      (let (data : any) (effect cap "read" "https: //example.com"))
      (yield))))
```

### 4.3 `effect` Primitive

**Signature:** `(effect capability operation & args)`

**Full Implementation:**

```t2
(fn effect ((capability : Capability) (operation : string) (rest args : (Array any))) : any
  "Perform a side-effect with capability authorization"

  ;; Yield to scheduler for verification and execution
  (yield
    (object
      (type       "effect")
      (capability capability)
      (operation  operation)
      (args       args))))
```

**Scheduler's Effect Handler:**

```t2
(method handle_effect ((task : Task) (capability : Capability) (operation : string) (args : (Array any))) (returns void)
  "Verify capability and dispatch effect"

  ;; 1. Verify task holds the capability
  (when (not ((. (. task capabilities) has) capability))
    ((. this emit_agc_code) "AGC-CAP500"
      (+ "Task " (. task id) " attempted effect without capability"))
    (set! (. task status) "crashed")
    ((. task recordCritical) "AGC-CAP500" "Unauthorized capability usage")
    (return))

  ;; 2. Verify capability allows this operation
  (when (not ((. capability canPerform) operation))
    ((. this emit_agc_code) "AGC-CAP510"
      (+ "Capability " (. capability type) " does not support operation " operation))
    (set! (. task status) "crashed")
    (return))

  ;; 3. Record effect in history
  ((. task recordEffect) capability operation args)

  ;; 4. Dispatch effect (with latency tracking)
  (let (start_time : number) (timestamp))
  (let (result : any) null)
  
  (try
    (set! result ((. this dispatch_effect) capability operation args))
    (catch error
      ((. this emit_agc_code) "AGC-E001"
        (+ "Effect failed: " (. error message)))
      ((. task recordExceptional) "effect_error" (object (operation operation) (error error)))))
  
  (let (duration : number) (- (timestamp) start_time))
  
  ;; 5. Check for slow effects
  (when (> duration 100)  ; 100ms threshold
    ((. this emit_agc_code) "AGC-E050"
      (+ "Slow effect: " operation " took " duration "ms")))
  
  ;; 6. Resume generator with result
  (set! (. task gen) ((. (. task gen) next) result)))

(method dispatch_effect ((capability : Capability) (operation : string) (args : (Array any))) (returns any)
  "Actually perform the effect (calls into JavaScript runtime)"
  
  (match (. capability type)
    ("log"
      ((. this effect_log) operation args))
    
    ("io"
      ((. this effect_io) operation args capability))
    
    ("timer"
      ((. this effect_timer) operation args))
    
    ("random"
      ((. this effect_random) operation args))
    
    ("shared-blob"
      ((. this effect_shared_blob) operation args capability))
    
    (_
      (throw (Error (+ "Unknown capability type: " (. capability type)))))))

;; Effect implementations

(method effect_log ((operation : string) (args : (Array any))) (returns void)
  (switch operation
    ("info" (console.log "[INFO]" ...args))
    ("warn" (console.warn "[WARN]" ...args))
    ("error" (console.error "[ERROR]" ...args))
    ("debug" (console.debug "[DEBUG]" ...args))))

(method effect_io ((operation : string) (args : (Array any)) (capability : Capability)) (returns any)
  (switch operation
    (case "fetch"
      (let (url : string) (index args 0))
      ;; Check allowed hosts
      (when (and (. capability metadata allowedHosts)
                 (> (length (. capability metadata allowedHosts)) 0))
        (let (host : string) (extract_host url))
        (when (not (includes? (. capability metadata allowedHosts) host))
          (throw (Error (+ "Host not allowed: " host)))))
      ;; Perform fetch
      (await (fetch url)))
    
    (case "read"
      (let (path : string) (index args 0))
      ;; Node.js file read, etc.
      ...)

    (case "write"
      (let (path : string) (index args 0))
      (let (data : any)   (index args 1))
      ...)))

(method effect_timer ((operation : string) (args : (Array any))) (returns any)
  (switch operation
    (case "sleep"
      (let (ms : number) (index args 0))
      ;; In cooperative context, this is tricky - may need to block task
      ;; and resume after timeout
      (this.schedule_task_resume (. this current_task) ms))
    
    (case "set_timeout"
      (let (callback : Function) (index args 0))
      (let (ms : number)         (index args 1))
      (setTimeout callback ms))

    (case "set_interval"
      (let (callback : Function) (index args 0))
      (let (ms : number)         (index args 1))
      (setInterval callback ms))))

(method effect_random ((operation : string) (args : (Array any))) (returns any)
  (switch operation
    (case "next"       ((. Math random)))
    (case "next_int"
      (let (max : number) (index args 0))
      ((. Math floor) (* ((. Math random)) max)))
    (case "next_float"
      (let (min : number) (index args 0))
      (let (max : number) (index args 1))
      (+ min (* ((. Math random)) (- max min))))))
```

**JavaScript Implementation:**
```javascript
handleEffect(task, capability, operation, args) {
  // 1. Verify capability ownership
  if (!task.capabilities.has(capability)) {
    this.emitAGCCode('AGC-CAP500', 
      `Task ${task.id} attempted effect without capability`);
    task.status = 'crashed';
    task.recordCritical('AGC-CAP500', 'Unauthorized capability usage');
    return;
  }
  
  // 2. Verify operation allowed
  if (!capability.canPerform(operation)) {
    this.emitAGCCode('AGC-CAP510',
      `Capability ${capability.type} does not support operation ${operation}`);
    task.status = 'crashed';
    return;
  }
  
  // 3. Record in history
  task.recordEffect(capability, operation, args);
  
  // 4. Dispatch with latency tracking
  const startTime = Date.now();
  let result;
  
  try {
    result = this.dispatchEffect(capability, operation, args);
  } catch (error) {
    this.emitAGCCode('AGC-E001', `Effect failed:  ${error.message}`);
    task.recordExceptional('effect_error', { operation, error });
    throw error;
  }
  
  const duration = Date.now() - startTime;
  
  // 5. Check for slow effects
  if (duration > 100) {
    this.emitAGCCode('AGC-E050', 
      `Slow effect: ${operation} took ${duration}ms`);
  }
  
  // 6. Resume generator
  return result;
}

dispatchEffect(capability, operation, args) {
  switch (capability.type) {
    case 'log':
      return this.effectLog(operation, args);
    case 'io':
      return this.effectIO(operation, args, capability);
    case 'timer':
      return this.effectTimer(operation, args);
    case 'random':
      return this.effectRandom(operation, args);
    default:
      throw new Error(`Unknown capability type:  ${capability.type}`);
  }
}

effectLog(operation, args) {
  switch (operation) {
    case 'info': console.log('[INFO]', ...args); break;
    case 'warn': console.warn('[WARN]', ...args); break;
    case 'error': console.error('[ERROR]', ...args); break;
    case 'debug': console.debug('[DEBUG]', ...args); break;
  }
}

// ... other effect implementations
```

### 4.4 Effect History

Each task records all effects in `history_effects` ring buffer:

```javascript
{
  timestamp: 1234567890,
  capability: "uuid_of_capability",
  operation: "fetch",
  args: ["https://example.com"],
  duration: 45,  // milliseconds
  result: "success" | "error"
}
```

This enables:
- Effect-biased debugging
- Timeline weaving
- Replay testing (future)

### 4.5 AGC Codes for Capabilities & Effects

**Capability Codes:**
- `AGC-CAP500` - Unverified capability usage
- `AGC-CAP510` - Passing unregistered capability into spawn
- `AGC-CAP520` - Capability revoked mid_operation

**Effect Codes:**
- `AGC-E001` - Effect execution failed
- `AGC-E050` - Effect took too long (>100ms)
- `AGC-E051` - Effect timeout

---

## 📅 Stage 5: Diagnostics & Determinism (The "AGC" Layer)
**Goal:** Observability, debugging, and AGC-coded diagnostics.

### 5.1 Complete AGC Code Catalog

Based on DESIGN.md and DLITE.md, here is the full set of AGC diagnostic codes:

#### Message-Level (M0xx)
- **AGC-M010** - Mailbox overflow (any policy)
- **AGC-M020** - Slow consumer (mailbox filling up)
- **AGC-M030** - Unhandled message warning
- **AGC-M031** - Message stuck too long in mailbox
- **AGC-M040** - Excessive mailbox scanning
- **AGC-M050** - Send to non-existent PID

#### Protocol-Level (PROT2xx)
- **AGC-PROT200** - Protocol mismatch (send uses wrong message shape)
- **AGC-PROT210** - Unhandled protocol message
- **AGC-PROT220** - Unreachable receive clause
- **AGC-PROT230** - Breaking protocol change across versions (hot_swap incompatibility)

#### Scheduler-Level (S1xx)
- **AGC-S100** - System overload detected
- **AGC-S999** - Unknown primitive or internal error

#### Effect-Level (E0xx)
- **AGC-E001** - Effect execution failed
- **AGC-E050** - Slow effect (>100ms)
- **AGC-E051** - Effect timeout

#### Type-Level (T1xx) - for Opaque Types
- **AGC-T100** - Opaque type misuse
- **AGC-T110** - Invalid constructor usage
- **AGC-T120** - Invalid accessor usage

#### Behavior-Level (BEH3xx) - for t2-agc-otp
- **AGC-BEH300** - Missing required callback
- **AGC-BEH310** - Wrong return shape for behavior callback
- **AGC-BEH320** - Behavior protocol reply mismatch
- **AGC-BEH330** - State machine unregistered state

#### Capability-Level (CAP5xx)
- **AGC-CAP500** - Unverified capability usage
- **AGC-CAP510** - Passing unregistered capability
- **AGC-CAP520** - Capability revoked

#### Coverage-Level (COV4xx) - for Dlite
- **AGC-COV400** - Dynamic message shape not analyzable
- **AGC-COV410** - Unknown target PID; cannot check protocol
- **AGC-COV420** - Receive pattern too dynamic
- **AGC-COV430** - Opaque type missing metadata
- **AGC-COV440** - Behavior implemented manually
- **AGC-COV450** - Code path escapes analyzable subset

### 5.2 AGC Code Emission

```t2
(class AGCEvent
  (class-body
    ;; All fields set via constructor shorthand
    (constructor
      ((public code      : string)
       (public message   : string)
       (public timestamp : number)
       (public task_id   : (union number null))
       (public context   : object)))))

(method emit_agc_code ((code : string) (message : string)) (returns void)
  "Emit an AGC diagnostic code to multiple channels"

  (let (event : AGCEvent)
    (new AGCEvent
      code
      message
      (timestamp)
      (if (. this current_task) (. this current_task id) null)
      (object)))

  ;; 1. Add to global AGC codes list
  ((. (. this agc_codes_emitted) push) event)

  ;; 2. Add to orchestrator history
  ((. (. this orchestrator_history) push) event)

  ;; 3. Add to current task's critical history (if in task context)
  (when (. this current_task)
    ((. (. this current_task) recordCritical) code message))

  ;; 4. Emit to console (with color coding if possible)
  ((. console error) (+ "[" code "] " message))

  ;; 5. Optional: Send to external monitoring system
  (when (. this monitoring_callback)
    ((. (. this monitoring_callback) call) event)))
```

**JavaScript Implementation:**
```javascript
emitAGCCode(code, message, context = {}) {
  const event = {
    code,
    message,
    timestamp: Date.now(),
    taskId: this.currentTask?.id,
    context
  };
  
  // 1. Global list
  this.agcCodesEmitted.push(event);
  
  // 2. Orchestrator history
  this.orchestratorHistory.push(event);
  
  // 3. Task critical history
  if (this.currentTask) {
    this.currentTask.recordCritical(code, message);
  }
  
  // 4. Console with color
  const color = code.startsWith('AGC-E') ? '\x1b[31m' : // Red for errors
                code.startsWith('AGC-S') ? '\x1b[33m' : // Yellow for system
                '\x1b[36m'; // Cyan for others
  console.error(`${color}[${code}]\x1b[0m ${message}`);
  
  // 5. Optional monitoring
  if (this.monitoringCallback) {
    this.monitoringCallback(event);
  }
}
```

### 5.3 History Ring Buffers (Three Types)

Each task maintains three separate ring-buffered histories:

#### 5.3.1 Effects History (`history_effects`)
Records all `effect` calls:
```javascript
{
  timestamp: number,
  capability: string,  // capability.id
  operation: string,
  args: any[],
  duration: number,
  result: 'success' | 'error'
}
```

#### 5.3.2 Exceptional History (`history_exceptional`)
Records "interesting" runtime events:
```javascript
{
  timestamp: number,
  type: string,  // 'blocked_on_receive', 'woken_by_message', 'effect_error', etc.
  data: object
}
```

#### 5.3.3 Critical History (`history_critical`)
Records AGC codes emitted in the context of this task:
```javascript
{
  timestamp: number,
  code: string,  // 'AGC-M010', etc.
  message: string
}
```

### 5.4 Global `__t2agc__` Debugging Object

The runtime exposes a global object for introspection:

```javascript
globalThis.__t2agc__ = {
  // Core runtime
  scheduler: Scheduler,
  
  // Debug API
  debug: {
    listTasks() {
      return Array.from(scheduler.tasks.entries()).map(([pid, task]) => ({
        pid,
        name: task.name,
        status: task.status,
        priority: task.priority,
        mailboxSize: task.mailbox.length,
        totalReductions: task.totalReductions
      }));
    },
    
    dumpTask(pid) {
      const task = scheduler.tasks.get(pid);
      if (!task) return null;
      
      return {
        id: task.id,
        name: task.name,
        priority: task.priority,
        status: task.status,
        budget: task.budget,
        mailbox: task.mailbox,
        capabilities: Array.from(task.capabilities).map(c => c.type),
        stats: {
          totalReductions: task.totalReductions,
          messagesSent: task.totalMessagesSent,
          messagesReceived: task.totalMessagesReceived,
          mailboxScans: task.mailboxScanCount
        },
        histories: {
          effects: task.historyEffects.toArray(),
          exceptional: task.historyExceptional.toArray(),
          critical: task.historyCritical.toArray()
        }
      };
    },
    
    dumpMailbox(pid) {
      const task = scheduler.tasks.get(pid);
      return task ? task.mailbox : null;
    },
    
    listWaitingTasks() {
      return Array.from(scheduler.waitingTasks.keys());
    },
    
    getAGCCodes(limit = 50) {
      return scheduler.agcCodesEmitted.slice(-limit);
    },
    
    weaveTaskHistory(pid) {
      const task = scheduler.tasks.get(pid);
      if (!task) return null;
      
      // Merge all three histories chronologically
      const combined = [
        ...task.historyEffects.toArray().map(e => ({ ...e, source:  'effect' })),
        ...task.historyExceptional.toArray().map(e => ({ ...e, source:  'exceptional' })),
        ...task.historyCritical.toArray().map(e => ({ ...e, source:  'critical' }))
      ];
      
      combined.sort((a, b) => a.timestamp - b.timestamp);
      return combined;
    },
    
    weaveSystemHistory(limit = 200) {
      // Return orchestrator history
      return scheduler.orchestratorHistory.toArray();
    },
    
    ppTree() {
      // Pretty-print task tree (for supervisors in Stage 7)
      console.log("Task Tree: ");
      for (const [pid, task] of scheduler.tasks) {
        console.log(`  ${pid}:  ${task.name} [${task.status}]`);
      }
    }
  }
};
```

### 5.5 Timeline Weaving

Timeline weaving combines multiple event streams into a chronological view:

```javascript
function weaveTimeline(taskIds = null) {
  const events = [];
  
  // Add orchestrator events
  events.push(...globalThis.__t2agc__.scheduler.orchestratorHistory.toArray()
    .map(e => ({ ...e, source:  'orchestrator' })));
  
  // Add task-specific events
  if (taskIds) {
    for (const pid of taskIds) {
      const woven = globalThis.__t2agc__.debug.weaveTaskHistory(pid);
      if (woven) {
        events.push(...woven.map(e => ({ ...e, taskId:  pid })));
      }
    }
  } else {
    // Include all tasks
    for (const [pid, task] of globalThis.__t2agc__.scheduler.tasks) {
      const woven = globalThis.__t2agc__.debug.weaveTaskHistory(pid);
      if (woven) {
        events.push(...woven.map(e => ({ ...e, taskId:  pid })));
      }
    }
  }
  
  // Sort chronologically
  events.sort((a, b) => a.timestamp - b.timestamp);
  
  return events;
}

globalThis.__t2agc__.debug.weaveTimeline = weaveTimeline;
```

### 5.6 Example: Using the Debug API

```javascript
// List all tasks
const tasks = __t2agc__.debug.listTasks();
console. log(tasks);

// Dump a specific task
const taskInfo = __t2agc__.debug.dumpTask(5);
console.log(taskInfo);

// View recent AGC codes
const codes = __t2agc__.debug.getAGCCodes(20);
codes.forEach(c => console.log(`${c.code}:  ${c.message}`));

// Weave a timeline for specific tasks
const timeline = __t2agc__.debug.weaveTimeline([1, 2, 3]);
timeline.forEach(event => {
  console.log(`[${new Date(event.timestamp).toISOString()}] ${event.source}:  ${JSON.stringify(event)}`);
});
```

## 📅 Stage 6: Macros & Syntactic Sugar
**Goal:** Make t2-agc code look clean and idiomatic.

### 6.1 `task` Macro

The `task` macro provides syntactic sugar for defining tasks:

```t2
;; User writes:
(task counter (initial_value cap_log)
  ("priority" "normal")
  ("max_mailbox" 500)
  ("on_overflow" "drop-oldest")
  
  (let state initial_value)
  (loop
    (receive
      ((array "inc" n)
        (set! state (+ state n))
        (effect cap_log "info" "Incremented to" state))
      
      ((array "get" from)
        (send from state)))
    (yield)
    (recur)))

;; Expands to:
(let (counter_fn)
  (generator-fn (initial_value cap_log)
    ;; __t2_task_options set at entry; mailbox configured by spawn_task
    (begin
      (set! (. (current_generator) __t2_task_options)
        (object (priority "normal") (max_mailbox 500) (on_overflow "drop-oldest") (protocol null)))
      (let (state) initial_value)
      (loop
        ...))))

;; When spawned via (spawn_task counter (array 0 my_cap_log)) which expands to:
(begin
  (let (__task_opts) (. counter_fn __t2_task_options))
  (let (__pid) (spawn counter_fn (array 0 my_cap_log) (. __task_opts priority) (make_set)))
  (let (__task_inst) (map_get (. (get_global_scheduler) tasks) __pid))
  ((. __task_inst configure_mailbox) (. __task_opts max_mailbox) (. __task_opts on_overflow))
  __pid)
```

**Macro Definition:**
```t2
(defmacro task ((name) (params) (rest options_and_body))
  "Define a task with options.
   Leading 2-element string-keyed tuples are treated as options;
   everything after is the task body."
  
  ;; Options are leading forms of the shape ("key" value)
  (let (options)
    (take_while
      (lambda ((form))
        (and ((. Array isArray) form) (= (length form) 2) (== (typeof (head form)) "string")))
      options_and_body))
  (let (body)        (drop (length options) options_and_body))
  
  ;; Extract known option values with defaults
  (let (priority)    (or (get_option options "priority")    "normal"))
  (let (max_mailbox) (or (get_option options "max_mailbox") 1000))
  (let (on_overflow) (or (get_option options "on_overflow") "drop-oldest"))
  (let (protocol)    (get_option options "protocol"))
  
  (quasi (let (~(symbol (+ (string name) "_fn")))
    (generator-fn ~params
      (begin
        (set! (. (current_generator) __t2_task_options)
          (object
            (priority    ~priority)
            (max_mailbox ~max_mailbox)
            (on_overflow ~on_overflow)
            (protocol    ~protocol)))
        ~@body)))))
```

### 6.2 `defprotocol` Macro

Defines message protocols at compile time and stores them in a global registry:

```t2
**Macro Definition:**
```t2
(defmacro defprotocol ((name) (rest message_specs))
  "Define a message protocol, register it globally, and generate
   per-message constructor functions.

   Each message_spec is an array form:
     (array \"tag\" param* (\"reply_shape\" type)?)
   where trailing 2-element string-keyed tuples are options."
  
  (let (proto_name) (string name))
  (let (lower_name) (string_lower proto_name))
  
  ;; Helper: parse a spec into tag, params list, and opts list
  (let (parse_spec) (lambda ((spec))
    (let (tag)    (nth spec 1))
    (let (raw)    (drop 2 spec))
    (let (params) (filter raw (lambda ((p))
      (not (and ((. Array isArray) p) (= (length p) 2) (== (typeof (head p)) "string"))))))
    (let (opts)   (filter raw (lambda ((p))
      (and ((. Array isArray) p) (= (length p) 2) (== (typeof (head p)) "string")))))
    (object (tag tag) (params params) (opts opts))))
  
  (let (parsed) (map message_specs parse_spec))
  
  ;; Build (object (tag ...) ...) form for one parsed spec
  (let (make_msg_obj) (lambda ((info))
    (let (tag)    (. info tag))
    (let (params) (. info params))
    (let (reply)  (get_option (. info opts) "reply_shape"))
    (if reply
      (quasi (object
        (tag         ~tag)
        (arity       ~(length params))
        (params      (array ~@(map params string)))
        (reply_shape ~reply)))
      (quasi (object
        (tag    ~tag)
        (arity  ~(length params))
        (params (array ~@(map params string))))))))
  
  ;; Build a constructor let-binding for one parsed spec
  (let (make_ctor) (lambda ((info))
    (let (tag)     (. info tag))
    (let (params)  (. info params))
    (let (fn_name) (symbol (+ "make_" lower_name "_"
                              (string_replace tag "-" "_"))))
    (quasi (let (~fn_name)
      (lambda (~@(map params (lambda ((p)) (quasi (~p)))))
        (array ~tag ~@params))))))
  
  (quasi (begin
    ((. (. __t2agc__ protocols) set) ~proto_name
      (object
        (name     ~proto_name)
        (messages (array ~@(map parsed make_msg_obj)))))
    ~@(map parsed make_ctor))))
```

**Usage example:**
```t2
;; User writes:
(defprotocol Counter
  (array "inc" n)
  (array "get" from ("reply_shape" "integer"))
  (array "reset"))

;; Expands to:
(begin
  (map_set! (. __t2agc__ protocols) "Counter"
    (object
      (name "Counter")
      (messages (array
        (object (tag "inc")   (arity 1) (params (array "n")))
        (object (tag "get")   (arity 1) (params (array "from")) (reply_shape "integer"))
        (object (tag "reset") (arity 0) (params (array)))))))
  (let (make_counter_inc)   (lambda ((n))    (array "inc"   n)))
  (let (make_counter_get)   (lambda ((from)) (array "get"   from)))
  (let (make_counter_reset) (lambda ()       (array "reset"))))
```

**Runtime Protocol Storage:**
```javascript
globalThis.__t2agc__.protocols = new Map();

// Example stored protocol
__t2agc__.protocols.set('Counter', {
  name: 'Counter',
  messages: [
    { tag: 'inc', arity: 1, params: ['n'] },
    { tag: 'get', arity: 1, params: ['from'], replyShape: 'integer' },
    { tag: 'reset', arity: 0, params: [] }
  ]
});
```

### 6.3 `defopaque` Macro (from OTP.md)

Defines opaque types with encapsulation:

```t2
**Macro Definition:**
```t2
(defmacro defopaque ((name) (rest fields))
  "Define an opaque type with encapsulated fields.
   Each field spec is (field_name) or (field_name: type).
   Generates: a private backing class, a constructor make_<name>,
   per-field accessors <name>_<field>, and a predicate <name>?."
  
  (let (name_str)   (string name))
  (let (lower_name) (string_lower name_str))
  (let (class_sym)  (symbol (+ "__" name_str)))
  (let (ctor_sym)   (symbol (+ "make_" lower_name)))
  (let (pred_sym)   (symbol (+ lower_name "?")))
  
  ;; Extract the field name symbol from a field spec
  (let (field_sym_of) (lambda ((spec))
    (if (pair? spec) (head spec) spec)))
  ;; Extract the field type from a field spec (default "any")
  (let (field_type_of) (lambda ((spec))
    (if (and (pair? spec) (> (length spec) 1)) (nth spec 1) "any")))
  
  (quasi (begin
    ;; Private backing class (not exported)
    (class ~class_sym
      (class-body
        ~@(map fields (lambda ((spec))
            (let (fsym)  (field_sym_of spec))
            (let (ftype) (field_type_of spec))
            (quasi (field (~fsym : ~ftype)))))
        (field (__opaque_tag : symbol))))
    
    ;; Constructor: make_<name>(fields...)
    (let (~ctor_sym)
      (lambda (~@(map fields (lambda ((spec))
                  (quasi (~(field_sym_of spec))))))
        (let (__inst) (new ~class_sym))
        ~@(map fields (lambda ((spec))
            (let (fsym) (field_sym_of spec))
            (quasi (set! (. __inst ~fsym) ~fsym))))
        (set! (. __inst __opaque_tag) (symbol ~name_str))
        __inst))
    
    ;; Per-field accessors: <name>_<field>(instance)
    ~@(map fields (lambda ((spec))
        (let (fsym)    (field_sym_of spec))
        (let (acc_sym) (symbol (+ lower_name "_" (string fsym))))
        (quasi (let (~acc_sym)
          (lambda ((__inst)) (. __inst ~fsym))))))
    
    ;; Predicate: <name>?(obj)
    (let (~pred_sym)
      (lambda ((__obj))
        (and (object? __obj)
             (= (. __obj __opaque_tag) (symbol ~name_str)))))))
```

**Usage example:**
```t2
;; User writes:
(defopaque Counter
  (value))

;; Expands to:
(begin
  (class __Counter
    (class-body
      (field (value : any))
      (field (__opaque_tag : symbol))))
  
  (let (make_counter)
    (lambda ((value))
      (let (__inst) (new __Counter))
      (set! (. __inst value) value)
      (set! (. __inst __opaque_tag) (symbol "Counter"))
      __inst))
  
  (let (counter_value)
    (lambda ((__inst)) (. __inst value)))
  
  (let (counter?)
    (lambda ((__obj))
      (and (object? __obj)
           (= (. __obj __opaque_tag) (symbol "Counter"))))))
```

### 6.4 `spawn_task` Helper Macro

Simplifies spawning tasks defined with the `task` macro by reading the stored `__t2_task_options` metadata:

**Macro Definition:**
```t2
(defmacro spawn_task ((task_name) (args))
  "Spawn a task defined with the task macro.
   Reads the __t2_task_options stored on the generator function at
   definition time to configure priority and mailbox automatically."
  (let (fn_sym) (symbol (+ (string task_name) "_fn")))
  (quasi (begin
    (let (__task_opts) (. ~fn_sym __t2_task_options))
    (let (__pid)
      (spawn ~fn_sym ~args
        (. __task_opts priority)
        (make_set)))
    (let (__task_inst)
      (map_get (. (get_global_scheduler) tasks) __pid))
    ((. __task_inst configure_mailbox)
      (. __task_opts max_mailbox)
      (. __task_opts on_overflow))
    __pid)))
```

**Usage example:**
```t2
;; User writes:
(spawn_task counter (array 0 cap_log))

;; Expands to:
(begin
  (let (__task_opts) (. counter_fn __t2_task_options))
  (let (__pid)
    (spawn counter_fn (array 0 cap_log)
      (. __task_opts priority)
      (make_set)))
  (let (__task_inst)
    (map_get (. (get_global_scheduler) tasks) __pid))
  ((. __task_inst configure_mailbox)
    (. __task_opts max_mailbox)
    (. __task_opts on_overflow))
  __pid)
```

## 📅 Stage 7: OTP Basics (t2-agc-otp)
**Goal:** Higher-level reliability patterns.

### 7.1 Supervisors

**Child Spec Structure:**
```t2
;; Type definitions for ChildSpec
(export (type RestartPolicy (tlit "permanent") (tlit "transient") (tlit "temporary")))
(export (type ChildType (tlit "worker") (tlit "supervisor")))

(deftype ChildSpec
  ("id" symbol)
  ("start" function)           ; Function or behavior to spawn
  ("capabilities" (list_of Capability))
  ("restart_policy" RestartPolicy)
  ("shutdown_timeout" number)  ; milliseconds
  ("type" ChildType))
```

**Supervisor Behavior:**
```t2
(behavior supervisor (child_specs strategy max_restarts max_time)
  ("protocol" Supervisor)
  
  (let (children       : (Map symbol number)) (new Map))
  (let (restart_counts : (Map symbol (Array number))) (new Map))
  
  (loop
    (receive
      ;; Child died
      ((array "exit" child_id reason)
        (let spec (find_child_spec child_specs child_id))
        (match (. spec restart_policy)
          ("permanent" 
            (restart_child spec))
          
          ("transient"
            (when (not= reason "normal")
              (restart_child spec)))
          
          ("temporary"
            ;; Don't restart
            null)))
      
      ;; Start all children
      ((array "start_all" from)
        (for_each child_specs (lambda ((spec : ChildSpec))
          (let (pid : number) (start_child spec))
          ((. children set) (. spec id) pid)))
        (send from "ok"))
      
      ;; Introspection
      ((array "which_children" from)
        (send from children)))
    
    (yield)
    (recur))))

(fn restart_child ((spec : ChildSpec)) : void
  "Apply restart strategy"
  ;; Check restart limits
  (when (exceeded_restart_limit? spec)
    (emit_agc_code "AGC-SUP100" "Max restarts exceeded")
    (crash_supervisor))

  ;; Spawn child
  (let (pid : number) (spawn (. spec start) (array) "normal" (. spec capabilities)))
  ((. children set) (. spec id) pid)

  ;; Record restart
  (update_restart_count! (. spec id)))
```

### 7.2 Registries

Simple name->pid mapping:

```t2
(task registry ()
  (let (names : (Map string number)) (new Map))

  (loop
    (receive
      ((array "register" name pid)
        ((. names set) name pid))

      ((array "unregister" name)
        ((. names delete) name))

      ((array "whereis" name from)
        (send from ((. names get) name))))
    
    (yield)
    (recur)))
```

### 7.3 Behaviors (gen_server equivalent)

The `behavior` macro is a thin wrapper over `task` that attaches a protocol annotation via the `"protocol"` option, which the `task` macro captures into `__t2_task_options.protocol` for Dlite static analysis.

```t2
(defmacro behavior ((name) (protocol) (params) (rest body))
  "Define a behavior (gen_server style).
   Equivalent to a task with a 'protocol' option annotation.
   The protocol name is stored in __t2_task_options for Dlite analysis."
  (quasi (task ~name ~params
    ("protocol" ~protocol)
    ~@body)))
```

**Usage example:**
```t2
;; User writes:
(behavior counter_server Counter (initial_value cap_log)
  (let (state) initial_value)
  (loop
    (receive
      ((array "inc" n)   (set! state (+ state n)))
      ((array "get" from) (send from state)))
    (yield)
    (recur)))

;; Expands to:
(task counter_server (initial_value cap_log)
  ("protocol" Counter)
  (let (state) initial_value)
  (loop
    (receive
      ((array "inc" n)   (set! state (+ state n)))
      ((array "get" from) (send from state)))
    (yield)
    (recur)))
```

### 7.4 Integration with Debugging

All OTP-level constructs emit appropriate AGC codes and integrate with the debugging architecture:

- Supervisor restarts appear in orchestrator history
- Registry operations recorded
- Behavior lifecycle events tracked

## 📅 Next Steps Summary

1. **Implement**: Build `src/kernel.t2` with Scheduler and Task classes
2. **Implement**: Build `src/primitives.t2` with spawn, send, receive, effect
3. **Test**: Write ping_pong example (from EXAMPLES.md)
4. **Implement**: Pattern matching in `src/pattern.t2`
5. **Test**: Selective receive examples
6. **Implement**: Capabilities in `src/capabilities.t2`
7. **Implement**: AGC codes and debugging in `src/diagnostics.t2`
8. **Implement**: Macros in `src/macros.t2`
9. **Test**: Counter actor, echo server examples
10. **Implement**: OTP layer in `src/otp.t2`
11. **Integrate**: Dlite static analyzer (separate tool)

**This implementation plan now has sufficient detail to guide actual t2-lang implementation.**
