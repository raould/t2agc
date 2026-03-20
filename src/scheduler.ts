class Scheduler {
  run_queues: any;
  tasks: any;
  waiting_tasks: any;
  pid_counter: number = 0;
  current_task: any = null;
  tick_count: number = 0;
  running: boolean = false;
  total_run_queue_length: number = 0;
  avg_slice_duration: number = 0;
  overload_threshold_queue_length: number = 1000;
  overload_threshold_slice_ms: number = 50;
  orchestrator_history: RingBuffer;
  agc_codes_emitted: any[];
  priority_order: any[];
  monitoring_callback: any = null;
  constructor() {
    this.run_queues = ({
      critical: [],
      high: [],
      normal: [],
      low: [],
      idle: []
    });
    this.tasks = new Map();
    this.waiting_tasks = new Map();
    this.orchestrator_history = new RingBuffer(200);
    this.agc_codes_emitted = [];
    this.priority_order = ["critical", "high", "normal", "low", "idle"];
  }
  next_pid(): number {
    let pid: number = this.pid_counter;
    this.pid_counter = (this.pid_counter + 1);
    return pid;
  }
  schedule(task: any): void {
    let priority: string = task.priority;
    let queue: any[] = this.run_queues[priority];
    queue.push(task);
    this.total_run_queue_length = (this.total_run_queue_length + 1);
  }
  pick_next_task(): any {
    let found: any = null;
    let i: number = 0;
    while (((!found) && (i < this.priority_order.length))) {
      let priority: string = this.priority_order[i];
      let queue: any[] = this.run_queues[priority];
      if ((queue.length > 0)) {
        this.total_run_queue_length = (this.total_run_queue_length - 1);
        found = queue.shift();
      }
      i = (i + 1);
    }
    return found;
  }
  execute_slice(task: any): void {
    this.current_task = task;
    task.budget = task.initial_budget;
    let resume_val: any = task.pending_resume;
    task.pending_resume = undefined;
    let start_time: number = Date.now();
    try {
      while (((task.budget > 0) && (task.status == "runnable"))) {
        let step: any = task.gen.next(resume_val);
        resume_val = undefined;
        task.budget = (task.budget - 1);
        task.total_reductions = (task.total_reductions + 1);
        if (step.done) {
          task.status = "done";
          this.on_task_completed(task);
        }
        else {
          resume_val = this.handle_primitive(task, step.value);
        }
      }
    }
    catch (error) {
      this.on_task_crashed(task, error);
    }
    let duration: number = (Date.now() - start_time);
    this.record_slice_duration(duration);
    if ((task.status == "runnable")) {
      this.schedule(task);
    }
    this.current_task = null;
  }
  handle_primitive(task: any, primitive: any): any {
    match(primitive, ({
      type: "yield"
    })(undefined), ({
      type: "receive",
      patterns: patterns
    })(this.handle_receive(task, patterns)), ({
      type: "effect",
      capability: cap,
      operation: op,
      args: args
    })(this.handle_effect(task, cap, op, args)), _(this.crash_unknown_primitive(task, primitive)));
  }
  crash_unknown_primitive(task: any, primitive: any): any {
    this.emit_agc_code("AGC-S999", ("Unknown primitive: " + JSON.stringify(primitive)));
    task.status = "crashed";
    undefined;
  }
  run(): void {
    this.running = true;
    while (this.running) {
      this.tick_count = (this.tick_count + 1);
      this.check_overload();
      let task: any = this.pick_next_task();
      if (task) {
        this.execute_slice(task);
      }
      else {
        if ((this.waiting_tasks.size() == 0)) {
          this.running = false;
        }
        else {
          this.running = false;
        }
      }
    }
  }
  check_overload(): void {
    if ((this.total_run_queue_length > this.overload_threshold_queue_length)) {
      this.emit_agc_code("AGC-S100", ("Overload: run queue length " + this.total_run_queue_length));
    }
    if ((this.avg_slice_duration > this.overload_threshold_slice_ms)) {
      this.emit_agc_code("AGC-S100", (("Overload: avg slice duration " + this.avg_slice_duration) + "ms"));
    }
  }
  record_slice_duration(duration: number): void {
    let alpha: number = 0.1;
    this.avg_slice_duration = ((alpha * duration) + ((1 - alpha) * this.avg_slice_duration));
  }
  on_task_completed(task: any): void {
    this.orchestrator_history.push(({
      type: "task_completed",
      timestamp: Date.now(),
      pid: task.id
    }));
  }
  on_task_crashed(task: any, error: any): void {
    task.status = "crashed";
    this.emit_agc_code("AGC-S999", ((("Task " + task.id) + " crashed: ") + error.message));
    task.record_exceptional("crashed", ({
      error: error.message
    }));
  }
  handle_receive(task: any, patterns: any): any {
    if ((task.mailbox.length > 0)) {
      if (patterns) {
        return this.handle_selective_receive(task, patterns);
      }
      else {
        let msg: any = task.mailbox.shift();
        task.total_messages_received = (task.total_messages_received + 1);
        return msg;
      }
    }
    else {
      task.status = "waiting";
      task.waiting_patterns = patterns;
      this.waiting_tasks.set.call(this.waiting_tasks, task.id, task);
      task.record_exceptional("blocked_on_receive", ({
        
      }));
      return undefined;
    }
  }
  handle_selective_receive(task: any, patterns: any[]): any {
    task.mailbox_scan_count = (task.mailbox_scan_count + 1);
    let mailbox: any[] = task.mailbox;
    let scan_count: number = 0;
    let matched: any = null;
    let msg_index: number = 0;
    while (((!matched) && (msg_index < mailbox.length))) {
      let msg: any = mailbox[msg_index];
      scan_count = (scan_count + 1);
      task.total_mailbox_scan_operations = (task.total_mailbox_scan_operations + 1);
      if ((scan_count >= task.budget)) {
        task.record_exceptional("mailbox_scan_budget_exceeded", ({
          scanned: scan_count,
          remaining: (mailbox.length - msg_index)
        }));
        task.budget = 0;
        msg_index = mailbox.length;
      }
      let pattern_index: number = 0;
      while (((!matched) && (pattern_index < patterns.length))) {
        let ps: any = patterns[pattern_index];
        let bindings: any = match_pattern(ps.pattern, msg, ({
          
        }));
        if (bindings) {
          mailbox.splice(msg_index, 1);
          task.total_messages_received = (task.total_messages_received + 1);
          task.record_exceptional("received_message", ({
            message: msg,
            pattern_index: pattern_index,
            mailbox_position: msg_index
          }));
          matched = ({
            matched_pattern_index: pattern_index,
            message: msg,
            bindings: bindings
          });
        }
        pattern_index = (pattern_index + 1);
      }
      if ((!matched)) {
        msg_index = (msg_index + 1);
      }
    }
    if (matched) {
      return matched;
    }
    else {
      task.status = "waiting";
      task.waiting_patterns = patterns;
      this.waiting_tasks.set.call(this.waiting_tasks, task.id, task);
      task.record_exceptional("blocked_on_selective_receive", ({
        patterns_count: patterns.length,
        mailbox_size: mailbox.length
      }));
      return undefined;
    }
  }
  check_mailbox_health(task: any): void {
    if ((task.mailbox.length > (task.mailbox_max * 0.75))) {
      this.emit_agc_code("AGC-M020", (((("Slow consumer: task " + task.id) + " mailbox at ") + task.mailbox.length) + " messages"));
    }
    if ((task.mailbox.length > 0)) {
      let oldest_msg: any = task.mailbox[0];
      if (oldest_msg.timestamp) {
        let age: number = (Date.now() - oldest_msg.timestamp);
        if ((age > 5000)) {
          this.emit_agc_code("AGC-M031", ((("Message stuck for " + age) + "ms in task ") + task.id));
        }
      }
    }
    if ((task.mailbox_scan_count > 100)) {
      let avg_scan_ops: number = (task.total_mailbox_scan_operations / task.mailbox_scan_count);
      if ((avg_scan_ops > 50)) {
        this.emit_agc_code("AGC-M040", (((("Excessive mailbox scanning: task " + task.id) + " avg ") + avg_scan_ops) + " ops per scan"));
      }
    }
  }
  handle_effect(task: any, capability: any, operation: string, args: any[]): any {
    if ((!task.capabilities.has(capability))) {
      this.emit_agc_code("AGC-CAP500", (("Task " + task.id) + " attempted effect without capability"));
      task.status = "crashed";
      task.record_critical("AGC-CAP500", "Unauthorized capability usage");
      return undefined;
    }
    if ((!capability.can_perform(operation))) {
      this.emit_agc_code("AGC-CAP510", ((("Capability " + capability.cap_type) + " does not support operation ") + operation));
      task.status = "crashed";
      return undefined;
    }
    task.record_effect(capability, operation, args);
    let start_time: number = Date.now();
    let result: any = undefined;
    try {
      result = this.dispatch_effect(capability, operation, args);
    }
    catch (error) {
      this.emit_agc_code("AGC-E001", ("Effect failed: " + error.message));
      task.record_exceptional("effect_error", ({
        operation: operation,
        error: error.message
      }));
    }
    let duration: number = (Date.now() - start_time);
    if ((duration > 100)) {
      this.emit_agc_code("AGC-E050", (((("Slow effect: " + operation) + " took ") + duration) + "ms"));
    }
    result;
  }
  dispatch_effect(capability: any, operation: string, args: any[]): any {
    switch (capability.cap_type) {
      case "log":
        this.effect_log(operation, args);
        break;
      case "io":
        this.effect_io(operation, args, capability);
        break;
      case "timer":
        this.effect_timer(operation, args);
        break;
      case "random":
        this.effect_random(operation, args);
        break;
      default:
        throw new Error(("Unknown capability type: " + capability.cap_type));
    }
  }
  effect_log(operation: string, args: any[]): void {
    let prefix: string = (("[" + operation.toUpperCase()) + "]");
    switch (operation) {
      case "info":
        console.log.apply(console, [prefix].concat(args));
        break;
      case "warn":
        console.warn.apply(console, [prefix].concat(args));
        break;
      case "error":
        console.error.apply(console, [prefix].concat(args));
        break;
      case "debug":
        console.debug.apply(console, [prefix].concat(args));
        break;
    }
  }
  effect_io(operation: string, args: any[], capability: any): any {
    switch (operation) {
      case "fetch":
        let url: string = args[0];
        if ((capability.metadata.allowedHosts && (capability.metadata.allowedHosts.length > 0))) {
          let host: string = extract_host(url);
          if ((!capability.metadata.allowedHosts.includes(host))) {
            throw new Error(("Host not allowed: " + host));
          }
        }
        (await fetch(url));
        break;
      case "read":
        let path: string = args[0];
        throw new Error("effect_io 'read' not yet implemented");
        break;
      case "write":
        let path: string = args[0];
        let data: any = args[1];
        throw new Error("effect_io 'write' not yet implemented");
        break;
    }
  }
  effect_timer(operation: string, args: any[]): any {
    switch (operation) {
      case "sleep":
        let ms: number = args[0];
        throw new Error("effect_timer 'sleep' requires async scheduler");
        break;
      case "set_timeout":
        let callback: any = args[0];
        let ms: number = args[1];
        setTimeout(callback, ms);
        break;
      case "set_interval":
        let callback: any = args[0];
        let ms: number = args[1];
        setInterval(callback, ms);
        break;
    }
  }
  effect_random(operation: string, args: any[]): any {
    switch (operation) {
      case "next":
        Math.random();
        break;
      case "next_int":
        let max: number = args[0];
        Math.floor((Math.random() * max));
        break;
      case "next_float":
        let min: number = args[0];
        let max: number = args[1];
        (min + (Math.random() * (max - min)));
        break;
    }
  }
  emit_agc_code(code: string, message: string): void {
    let event: AGCEvent = new AGCEvent(code, message, Date.now(), (this.current_task ? this.current_task.id : null), ({
      
    }));
    this.agc_codes_emitted.push(event);
    this.orchestrator_history.push(event);
    if (this.current_task) {
      this.current_task.record_critical(code, message);
    }
    console.error(((("[" + code) + "] ") + message));
    if (this.monitoring_callback) {
      this.monitoring_callback.call(null, event);
    }
  }
}
