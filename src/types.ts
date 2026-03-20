export type Priority  = "critical" | "high" | "normal" | "low" | "idle";
export type TaskStatus  = "runnable" | "waiting" | "done" | "crashed";
export type MailboxOverflowPolicy  = "drop-oldest" | "drop-newest" | "reject" | "escalate" | "block-sender";
export type CapabilityType  = "log" | "io" | "timer" | "random" | "shared-blob";
export type RestartPolicy  = "permanent" | "transient" | "temporary";
export type ChildType  = "worker" | "supervisor";
