/**
 * Tests for Capability — the opaque authority token for side effects.
 */

import { describe, it } from 'vitest';
import { fromSourceEndToEnd } from './helpers.js';

const CAPABILITY_DEF = `
(export (class Capability
  (class-body
    (field (id : string) "")

    (constructor
      ((public cap_type   : string)
       (public operations : (type-array string))
       (public metadata   : any))
      (set! (. this id) (method-call (. globalThis crypto) randomUUID)))

    (method can_perform ((operation : string)) (returns boolean)
      (return (method-call (. this operations) includes operation))))))

(export (fn make_log_capability () : Capability
  (return (new Capability "log" (array "info" "warn" "error" "debug") (object)))))

(export (fn make_io_capability ((allowed_hosts : (type-array string))) : Capability
  (return (new Capability "io" (array "read" "write" "fetch")
    (object (allowedHosts allowed_hosts))))))

(export (fn make_timer_capability () : Capability
  (return (new Capability "timer" (array "sleep" "set_timeout" "set_interval") (object)))))

(export (fn make_random_capability () : Capability
  (return (new Capability "random" (array "next" "next_int" "next_float") (object)))))
`;

describe('Capability', () => {
  it('constructor sets type, operations, and metadata', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${CAPABILITY_DEF}
      (let (cap) (new Capability "log" (array "info" "warn") (object)))
      (asrt (. cap cap_type) "log")
      (asrt (. (. cap operations) length) 2)
    )`);
  });

  it('id is a non-empty UUID string', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${CAPABILITY_DEF}
      (let (cap) (new Capability "timer" (array) (object)))
      (asrt (> (. (. cap id) length) 0) true)
    )`);
  });

  it('two capabilities have different ids', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${CAPABILITY_DEF}
      (let (a) (new Capability "log" (array) (object)))
      (let (b) (new Capability "log" (array) (object)))
      (asrt (!= (. a id) (. b id)) true)
    )`);
  });

  it('can_perform returns true for an allowed operation', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${CAPABILITY_DEF}
      (let (cap) (new Capability "log" (array "info" "warn" "error") (object)))
      (asrt ((. cap can_perform) "info")  true)
      (asrt ((. cap can_perform) "warn")  true)
      (asrt ((. cap can_perform) "error") true)
    )`);
  });

  it('can_perform returns false for a disallowed operation', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${CAPABILITY_DEF}
      (let (cap) (new Capability "log" (array "info") (object)))
      (asrt ((. cap can_perform) "delete") false)
      (asrt ((. cap can_perform) "fetch")  false)
    )`);
  });

  it('make_log_capability produces correct type and operations', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${CAPABILITY_DEF}
      (let (cap) (make_log_capability))
      (asrt (. cap cap_type) "log")
      (asrt ((. cap can_perform) "info")  true)
      (asrt ((. cap can_perform) "warn")  true)
      (asrt ((. cap can_perform) "error") true)
      (asrt ((. cap can_perform) "debug") true)
      (asrt ((. cap can_perform) "fetch") false)
    )`);
  });

  it('make_io_capability includes allowed_hosts in metadata', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${CAPABILITY_DEF}
      (let (cap) (make_io_capability (array "example.com")))
      (asrt (. cap cap_type) "io")
      (asrt ((. cap can_perform) "fetch") true)
      (asrt (. (. (. cap metadata) allowedHosts) 0) "example.com")
    )`);
  });

  it('make_timer_capability has sleep, set_timeout, set_interval', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${CAPABILITY_DEF}
      (let (cap) (make_timer_capability))
      (asrt (. cap cap_type) "timer")
      (asrt ((. cap can_perform) "sleep")        true)
      (asrt ((. cap can_perform) "set_timeout")  true)
      (asrt ((. cap can_perform) "set_interval") true)
    )`);
  });

  it('make_random_capability has next, next_int, next_float', () => {
    fromSourceEndToEnd(`(program
      (import (object (named (array (object (name "asrt"))))) "./helpers.js")
      ${CAPABILITY_DEF}
      (let (cap) (make_random_capability))
      (asrt (. cap cap_type) "random")
      (asrt ((. cap can_perform) "next")       true)
      (asrt ((. cap can_perform) "next_int")   true)
      (asrt ((. cap can_perform) "next_float") true)
    )`);
  });
});
