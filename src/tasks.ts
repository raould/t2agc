export type Priority  = "low" | "normal" | "high";
export type TaskStatus  = "runnable" | "waiting" | "done" | "crashed";
export class Task {
  id: string;
  priority: Priority;
  status: TaskStatus;
  gen: unknown;
  mailbox: unknown[];
  budget: number;
  history: unknown[];
  nextInput: unknown;
  waitingFor;
  capabilities;
  constructor(id: string, gen, priority: Priority) {
    this.id = id;
    this.gen = gen;
    this.priority = (priority ? priority : "2normal");
    this.status = "runnable";
    this.mailbox = [];
    this.budget = 200;
    this.history = [];
    this.nextInput = undefined;
    this.waitingFor = null;
    this.capabilities = [];
  }
}
