class Task {
  name: string = "";
  status: TaskStatus = "runnable";
  gen: any;
  budget: number = 100;
  initial_budget: number = 100;
  mailbox: any[] = [];
  mailbox_max: number = 1000;
  mailbox_overflow_policy: MailboxOverflowPolicy = "drop-oldest";
  waiting_patterns: any[] | null = null;
  pending_resume: any;
  history_effects: RingBuffer;
  history_exceptional: RingBuffer;
  history_critical: RingBuffer;
  created_at: number = 0;
  total_reductions: number = 0;
  total_messages_sent: number = 0;
  total_messages_received: number = 0;
  mailbox_scan_count: number = 0;
  total_mailbox_scan_operations: number = 0;
  constructor(public id: number, gen_fn: Function, args: any[], public priority: Priority, public capabilities: Set<Capability>) {
    this.name = (gen_fn.name || ("task-" + String(id)));
    this.gen = apply(gen_fn, args);
    this.history_effects = new RingBuffer(100);
    this.history_exceptional = new RingBuffer(50);
    this.history_critical = new RingBuffer(20);
    this.created_at = Date.now();
  }
  record_effect(capability: Capability, operation: string, args: any[]): void {
    this.history_effects.push(({
      timestamp: Date.now(),
      capability: capability.id,
      operation: operation,
      args: args
    }));
  }
  record_exceptional(event_type: string, data: object): void {
    this.history_exceptional.push(({
      timestamp: Date.now(),
      type: event_type,
      data: data
    }));
  }
  record_critical(code: string, message: string): void {
    this.history_critical.push(({
      timestamp: Date.now(),
      code: code,
      message: message
    }));
  }
  configure_mailbox(max_size: number, overflow_policy: MailboxOverflowPolicy): void {
    this.mailbox_max = max_size;
    this.mailbox_overflow_policy = overflow_policy;
  }
}
