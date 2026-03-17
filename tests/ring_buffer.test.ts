/**
 * Tests for RingBuffer — the fixed-size circular buffer used by Task history
 * and Scheduler orchestrator history.
 *
 * Each test uses a self-contained inline t2 program so the tests are
 * independent of the current state of src/ring_buffer.t2.
 */

import { describe, it } from 'vitest';
import { fromSourceEndToEnd } from './helpers.js';

// ── shared inline definition ──────────────────────────────────────────────────

const RING_BUFFER_DEF = `
(export (class RingBuffer
  (class-body
    (field (buffer      : (type-array any)))
    (field (write_index : number) 0)
    (field (count       : number) 0)

    (constructor ((public size : number))
      (set! (. this buffer) (new Array size)))

    (method push ((item : any)) (returns void)
      (method-call (. this buffer) splice (. this write_index) 1 item)
      (set! (. this write_index) (% (+ (. this write_index) 1) (. this size)))
      (if (< (. this count) (. this size))
        (begin (set! (. this count) (+ (. this count) 1)))
        undefined))

    (method to_array () (returns (type-array any))
      (if (< (. this count) (. this size))
        (method-call (. this buffer) slice 0 (. this count))
        (method-call
          (method-call (. this buffer) slice (. this write_index))
          concat
          (method-call (. this buffer) slice 0 (. this write_index))))))))
`;

// ── tests ─────────────────────────────────────────────────────────────────────

describe('RingBuffer', () => {
  it('starts empty — to_array returns []', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt")) (object (name "asrtDeep"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      (let (rb) (new RingBuffer 3))
      (asrt (. rb count) 0)
      (asrtDeep ((. rb to_array)) (array))
    )`);
  });

  it('push fills buffer in order; to_array returns chronological order', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrtDeep"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      (let (rb) (new RingBuffer 3))
      ((. rb push) "a")
      ((. rb push) "b")
      ((. rb push) "c")
      (asrtDeep ((. rb to_array)) (array "a" "b" "c"))
    )`);
  });

  it('push beyond capacity overwrites oldest entry', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrtDeep"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      (let (rb) (new RingBuffer 3))
      ((. rb push) "a")
      ((. rb push) "b")
      ((. rb push) "c")
      ((. rb push) "d")
      (asrtDeep ((. rb to_array)) (array "b" "c" "d"))
    )`);
  });

  it('count never exceeds size', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      (let (rb) (new RingBuffer 2))
      ((. rb push) 1)
      ((. rb push) 2)
      ((. rb push) 3)
      ((. rb push) 4)
      (asrt (. rb count) 2)
    )`);
  });

  it('single-element buffer always returns the latest value', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrtDeep"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      (let (rb) (new RingBuffer 1))
      ((. rb push) "x")
      (asrtDeep ((. rb to_array)) (array "x"))
      ((. rb push) "y")
      (asrtDeep ((. rb to_array)) (array "y"))
    )`);
  });

  it('to_array wraps around correctly when buffer is full', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrtDeep"))))) "./helpers.js")
      ${RING_BUFFER_DEF}
      (let (rb) (new RingBuffer 4))
      ((. rb push) 1)
      ((. rb push) 2)
      ((. rb push) 3)
      ((. rb push) 4)
      ((. rb push) 5) ;; overwrites 1
      ((. rb push) 6) ;; overwrites 2
      (asrtDeep ((. rb to_array)) (array 3 4 5 6))
    )`);
  });
});
