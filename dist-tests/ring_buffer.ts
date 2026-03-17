export class RingBuffer {
  buffer: any[];
  write_index: number = 0;
  count: number = 0;
  constructor(public size: number) {
    this.buffer = new Array(size);
  }
  push(item: any): void {
    this.buffer.splice(this.write_index, 1, item);
    this.write_index = ((this.write_index + 1) % this.size);
    if ((this.count < this.size)) {
      this.count = (this.count + 1);
    }
  }
  to_array(): any[] {
    "Returns items in chronological (oldest-first) order.";
    if ((this.count < this.size)) {
      return this.buffer.slice(0, this.count);
    }
    else {
      return this.buffer.slice(this.write_index).concat(this.buffer.slice(0, this.write_index));
    }
  }
}
