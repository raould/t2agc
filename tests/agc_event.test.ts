/**
 * Tests for AGCEvent — the diagnostic code record emitted by the runtime.
 */

import { describe, it } from 'vitest';
import { fromSourceEndToEnd } from './helpers.js';

const AGC_EVENT_DEF = `
(export (class AGCEvent
  (class-body
    (constructor
      ((public code      : string)
       (public message   : string)
       (public timestamp : number)
       (public task_id   : any)
       (public context   : any))))))
`;

describe('AGCEvent', () => {
  it('constructor stores all fields on the instance', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${AGC_EVENT_DEF}
      (let (evt) (new AGCEvent "AGC-S001" "test message" 1000 42 (object)))
      (asrt (. evt code)      "AGC-S001")
      (asrt (. evt message)   "test message")
      (asrt (. evt timestamp) 1000)
      (asrt (. evt task_id)   42)
    )`);
  });

  it('task_id can be null (no current task)', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${AGC_EVENT_DEF}
      (let (evt) (new AGCEvent "AGC-M050" "unknown pid" 0 null (object)))
      (asrt (. evt task_id) null)
    )`);
  });

  it('context field holds arbitrary metadata', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${AGC_EVENT_DEF}
      (let (ctx) (object (queue_length 42) (pid 7)))
      (let (evt) (new AGCEvent "AGC-S100" "overload" 9999 1 ctx))
      (asrt (. (. evt context) queue_length) 42)
      (asrt (. (. evt context) pid)          7)
    )`);
  });
});
