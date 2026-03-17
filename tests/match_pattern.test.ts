/**
 * Tests for the pattern-matching utilities: match_pattern, try_match_patterns,
 * compute_match_result.
 */

import { describe, it } from 'vitest';
import { fromSourceEndToEnd } from './helpers.js';

const MATCH_PATTERN_DEF = `(program
;; Layer 1 — Pattern matching utilities.
;; Pure functions; no class dependencies.
;;
;; Pattern types:
;;   "_"            — wildcard, matches anything, no binding
;;   symbol         — JS Symbol; matches anything, binds value under that key
;;   number/string  — literal; must equal value exactly
;;   array          — structural; recursively matches each element

(fn match_pattern ((pattern : any) (value : any) (bindings : object)) : (union object null)
  "Attempt to match pattern against value.
   Returns a (possibly mutated) bindings object on success, or null on failure.
   'bindings' is passed in so recursive calls accumulate into the same object."
  ;; Wildcard — always matches, no binding produced
  (if (=== pattern "_")
    (then (return bindings)))
  ;; JS Symbol — variable binding; stores value under the symbol key
  (if (=== (typeof pattern) "symbol")
    (then (return (method-call Object assign bindings (object ([ pattern ] value))))))
  ;; Literal (number or string) — exact equality match
  (if (|| (=== (typeof pattern) "number") (=== (typeof pattern) "string"))
    (then
      (if (=== pattern value)
        (then (return bindings))
        (else (return null)))))
  ;; Array / tuple pattern — structural match element-by-element
  (if (method-call Array isArray pattern)
    (then
      (if (! (&& (method-call Array isArray value)
                  (=== (. pattern length) (. value length))))
        (then (return null)))
      (let (result : (union object null)) bindings)
      (let (i : number) 0)
      (while (&& result (< i (. pattern length)))
        (set! result
          (match_pattern (index pattern i) (index value i) result))
        (set! i (+ i 1)))
      (return result)))
  ;; No matching rule — fail
  (return null))


(fn try_match_patterns ((msg : any) (patterns : (Array any))) : boolean
  "Return true if msg matches any pattern in the waiting_patterns array.
   Used in send() to decide whether to wake a blocked task."
  (let (matched : boolean) false)
  (let (i : number) 0)
  (while (&& (! matched) (< i (. patterns length)))
    (let (ps : any) (index patterns i))
    (let (bindings : (union object null))
      (match_pattern (. ps pattern) msg (object)))
    (if bindings (then (set! matched true)))
    (set! i (+ i 1)))
  (return matched))


(fn compute_match_result ((msg : any) (patterns : (Array any))) : (union object null)
  "Return the first match-result object { matched_pattern_index, message, bindings }
   for msg against patterns, or null if no pattern matches.
   Used in send() to pre-compute the resume value for a waking task."
  (let (result : (union object null)) null)
  (let (i : number) 0)
  (while (&& (! result) (< i (. patterns length)))
    (let (ps : any) (index patterns i))
    (let (bindings : (union object null))
      (match_pattern (. ps pattern) msg (object)))
    (if bindings
      (then
        (set! result
          (object
            (matched_pattern_index i)
            (message               msg)
            (bindings              bindings)))))
    (set! i (+ i 1)))
  (return result))

)
`;

describe('match_pattern', () => {
  it('wildcard "_" always matches any value', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (asrt (!= (match_pattern "_" 42      (object)) null) true)
      (asrt (!= (match_pattern "_" "hello" (object)) null) true)
      (asrt (!= (match_pattern "_" null    (object)) null) true)
    )`);
  });

  it('string literal matches equal value', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (asrt (!= (match_pattern "ok" "ok"   (object)) null) true)
      (asrt       (match_pattern "ok" "fail" (object))       null)
    )`);
  });

  it('number literal matches equal value', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (asrt (!= (match_pattern 42 42 (object)) null) true)
      (asrt       (match_pattern 42 99 (object))       null)
    )`);
  });

  it('symbol binding captures the matched value', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (k) (Symbol "v"))
      (let (result) (match_pattern k 99 (object)))
      (asrt (!= result null) true)
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
      (asrt (!= result null) true)
    )`);
  });

  it('array pattern with symbol binding captures element', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${MATCH_PATTERN_DEF}
      (let (k) (Symbol "n"))
      (let (result)
        (match_pattern (array "inc" k) (array "inc" 5) (object)))
      (asrt (!= result null) true)
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
      (asrt (!= r null) true)
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
      (asrt (!= r null)          true)
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
