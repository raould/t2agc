class Capability {
  id: string = "";
  constructor(public cap_type: CapabilityType, public operations: string[], public metadata: object) {
    this.id = globalThis.crypto.randomUUID();
  }
  can_perform(operation: string): boolean {
    "Return true if this capability allows the given operation.";
    return this.operations.includes(operation);
  }
}
function make_log_capability(): Capability {
  "Full log capability: info, warn, error, debug.";
  return new Capability("log", ["info", "warn", "error", "debug"], ({
    
  }));
}
function make_io_capability(allowed_hosts: string[]): Capability {
  "I/O capability; optionally restricts fetch to specific hostnames.";
  return new Capability("io", ["read", "write", "fetch"], ({
    allowedHosts: allowed_hosts
  }));
}
function make_timer_capability(): Capability {
  "Timer capability: sleep, set_timeout, set_interval.";
  return new Capability("timer", ["sleep", "set_timeout", "set_interval"], ({
    
  }));
}
function make_random_capability(): Capability {
  "Random number generation capability.";
  return new Capability("random", ["next", "next_int", "next_float"], ({
    
  }));
}
