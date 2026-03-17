/**
 * Tests for the pattern-matching utilities: match_pattern, try_match_patterns,
 * compute_match_result.
 */

import { describe, it } from 'vitest';
import { fromSourceEndToEnd } from './helpers.js';

const MATCH_PATTERN_DEF = `
(fn match_pattern ((pattern : any) (value : any) (bindings : any)) : any
  (cond
    ((= pattern "_")
      bindings)
    ((== (typeof pattern) "symbol")
      (set! (index bindings pattern) value)
      bindings)
    ((or (== (typeof pattern) "number") (== (typeof pattern) "string"))
      (if (= pattern value)
        bindings
        null))
    ((method-call Array isArray pattern)
      (if (not (and (method-call Array isArray value)
                    (= (length pattern) (length value))))
        null
        (begin
          (let (result : any) bindings)
          (let (i : number) 0)
          (while (and result (< i (length pattern)))
            (set! result
              (match_pattern (index pattern i) (index value i) result))
            (set! i (+ i 1)))
          result)))
    (true null)))

(fn try_match_patterns ((msg : any) (patterns : any)) : boolean
  (let (matched : boolean) false)
  (let (i : number) 0)
  (while (and (not matched) (< i (length patterns)))
    (let (ps : any) (index patterns i))
    (let (bindings : any)
      (match_pattern (. ps pattern) msg (object)))
    (if bindings
      (begin (set! matched true))
      undefined)
    (set! i (+ i 1)))
  matched)

(fn compute_match_result ((msg : any) (patterns : any)) : any
  (let (result : any) null)
  (let (i : number) 0)
  (while (and (not result) (< i (length patterns)))
    (let (ps : any) (index patterns i))
    (let (bindings : any)
      (match_pattern (. ps pattern) msg (object)))
    (if bindings
      (begin
        (set! result
          (object
            (matched_pattern_index i)
            (message               msg)
            (bindings              bindings))))
      undefined)
    (set! i (+ i 1)))
  result)
`;

describe('match_pattern', () => {
  it('wildcard "_" always matches any value', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (asrt (not= (match_pattern "_" 42      (object)) null) true)
      (asrt (not= (match_pattern "_" "hello" (object)) null) true)
      (asrt (not= (match_pattern "_" null    (object)) null) true)
    )`);
  });

  it('string literal matches equal value', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (asrt (not= (match_pattern "ok" "ok"   (object)) null) true)
      (asrt       (match_pattern "ok" "fail" (object))       null)
    )`);
  });

  it('number literal matches equal value', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (asrt (not= (match_pattern 42 42 (object)) null) true)
      (asrt       (match_pattern 42 99 (object))       null)
    )`);
  });

  it('symbol binding captures the matched value', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (k) (Symbol "v"))
      (let (result) (match_pattern k 99 (object)))
      (asrt (not= result null) true)
      (asrt (index result k) 99)
    )`);
  });

  it('array pattern requires same length', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (asrt (match_pattern (array "a" "b") (array "a")     (object)) null)
      (asrt (match_pattern (array "a")     (array "a" "b") (object)) null)
    )`);
  });

  it('array pattern matches recursively', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (result)
        (match_pattern (array "ok" "_") (array "ok" 42) (object)))
      (asrt (not= result null) true)
    )`);
  });

  it('array pattern with symbol binding captures element', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (k) (Symbol "n"))
      (let (result)
        (match_pattern (array "inc" k) (array "inc" 5) (object)))
      (asrt (not= result null) true)
      (asrt (index result k) 5)
    )`);
  });

  it('non-array value fails an array pattern', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (asrt (match_pattern (array "x") "x" (object)) null)
      (asrt (match_pattern (array "x") 42  (object)) null)
    )`);
  });
});

describe('try_match_patterns', () => {
  it('returns true when at least one pattern matches', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (patterns)
        (array
          (object (pattern "stop"))
          (object (pattern (array "inc" "_")))))
      (asrt (try_match_patterns (array "inc" 3) patterns) true)
      (asrt (try_match_patterns "stop"          patterns) true)
    )`);
  });

  it('returns false when no pattern matches', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (patterns)
        (array (object (pattern "stop"))))
      (asrt (try_match_patterns "go"     patterns) false)
      (asrt (try_match_patterns (array)  patterns) false)
    )`);
  });
});

describe('compute_match_result', () => {
  it('returns null when no pattern matches', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (patterns) (array (object (pattern "stop"))))
      (asrt (compute_match_result "go" patterns) null)
    )`);
  });

  it('returns the matched_pattern_index for the winning clause', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (patterns)
        (array
          (object (pattern "stop"))
          (object (pattern (array "inc" "_")))))
      (let (r) (compute_match_result (array "inc" 7) patterns))
      (asrt (not= r null) true)
      (asrt (. r matched_pattern_index) 1)
      (asrt (. (. r message) 0) "inc")
      (asrt (. (. r message) 1) 7)
    )`);
  });

  it('returns bindings captured by symbol patterns', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (k) (Symbol "val"))
      (let (patterns)
        (array (object (pattern (array "set" k)))))
      (let (r) (compute_match_result (array "set" 99) patterns))
      (asrt (not= r null)          true)
      (asrt (. r matched_pattern_index) 0)
      (asrt (index (. r bindings) k) 99)
    )`);
  });

  it('picks the first matching pattern (index 0 before index 1)', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (patterns)
        (array
          (object (pattern "_"))
          (object (pattern "specific"))))
      (let (r) (compute_match_result "specific" patterns))
      (asrt (. r matched_pattern_index) 0)
    )`);
  });
});
