/** Writes protobuf fields in the order they're added. Only what network messages use. */
export class Protobuf {
  private readonly out: number[] = [];

  integer(field: number, value: number) {
    this.varint(field * 8);
    this.varint(value);
  }

  bytes(field: number, value: Uint8Array) {
    this.varint(field * 8 + 2);
    this.varint(value.length);
    for (const byte of value) this.out.push(byte);
  }

  string(field: number, value: string) {
    this.bytes(field, new TextEncoder().encode(value));
  }

  /** One value of a packed repeated field. Write the result with `bytes`. */
  packed(value: number) {
    this.varint(value);
  }

  get data() {
    return Uint8Array.from(this.out);
  }

  private varint(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Not a varint: ${value}`);
    let remaining = value;
    while (remaining >= 128) {
      this.out.push((remaining % 128) | 128);
      remaining = Math.floor(remaining / 128);
    }
    this.out.push(remaining);
  }
}

export function toHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads 0x-prefixed hex. */
export function fromHex(hex: string): Uint8Array | null {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) return null;
  return Uint8Array.from(hex.slice(2).match(/../g) ?? [], (pair) => parseInt(pair, 16));
}
