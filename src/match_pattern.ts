function try_match_patterns(msg: any, patterns: any[]): boolean {
  let matched: boolean = false;
  let i: number = 0;
  while (((!matched) && (i < patterns.length))) {
    let ps: any = patterns[i];
    let bindings: object | null = match_pattern(ps.pattern, msg, ({
      
    }));
    if (bindings) {
      matched = true;
    }
    i = (i + 1);
  }
  return matched;
}
function match_pattern(pattern: any, value: any, bindings: object): object | null {
  if ((pattern === "_")) {
    return bindings;
  }
  if ((typeof pattern === "symbol")) {
    return Object.assign(bindings, ({
      [pattern]: value
    }));
  }
  if (((typeof pattern === "number") || (typeof pattern === "string"))) {
    if ((pattern === value)) {
      return bindings;
    }
    else {
      return null;
    }
  }
  if (Array.isArray(pattern)) {
    if ((!(Array.isArray(value) && (pattern.length === value.length)))) {
      return null;
    }
    let result: object | null = bindings;
    let i: number = 0;
    while ((result && (i < pattern.length))) {
      result = match_pattern(pattern[i], value[i], result);
      i = (i + 1);
    }
    return result;
  }
  return null;
}
function compute_match_result(msg: any, patterns: any[]): object | null {
  let result: object | null = null;
  let i: number = 0;
  while (((!result) && (i < patterns.length))) {
    let ps: any = patterns[i];
    let bindings: object | null = match_pattern(ps.pattern, msg, ({
      
    }));
    if (bindings) {
      result = ({
        matched_pattern_index: i,
        message: msg,
        bindings: bindings
      });
    }
    i = (i + 1);
  }
  return result;
}
