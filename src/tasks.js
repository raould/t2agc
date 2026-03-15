export class Task {
    id;
    priority;
    status;
    gen;
    mailbox;
    budget;
    history;
    nextInput;
    waitingFor;
    capabilities;
    constructor(id, gen, priority) {
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
