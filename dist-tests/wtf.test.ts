import { describe, it } from "vitest";
import { asrt, asrtDeep } from "./helpers";
import { RingBuffer } from "./ring_buffer";
{
  let rb  = new RingBuffer(3);
  describe("RingBuffer", () => {
    it("push and to_array", () => {
      asrt(rb.push(1), undefined);
      asrt(rb.push(2), undefined);
      asrt(rb.push(3), undefined);
      asrtDeep(rb.to_array(), [1, 2, 3]);
      rb.push(4);
      asrtDeep(rb.to_array(), [4, 2, 3]);
    });
  });
}
