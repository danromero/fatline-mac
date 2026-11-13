/** Reads protobuf, strictly. Anything unexpected throws `Malformed`. */

export class Malformed extends Error {}

export interface Field {
  number: number;
  /** A varint value. */
  value?: bigint;
  /** A length-delimited value. */
  bytes?: Uint8Array;
}

export function readFields(data: Uint8Array): Field[] {
  const fields: Field[] = [];
  let at = 0;

  const varint = () => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (at >= data.length) throw new Malformed("Ends inside a number");
      const byte = data[at++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) {
        if (result >= 1n << 64n) throw new Malformed("Number too large");
        return result;
      }
    }
    throw new Malformed("Number too long");
  };

  while (at < data.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    if (number < 1) throw new Malformed("Bad field number");
    const wire = tag & 7n;
    if (wire === 0n) {
      fields.push({ number, value: varint() });
    } else if (wire === 2n) {
      const length = varint();
      if (length > BigInt(data.length - at)) throw new Malformed("Ends inside a field");
      const end = at + Number(length);
      fields.push({ number, bytes: data.subarray(at, end) });
      at = end;
    } else {
      throw new Malformed("Unexpected field type");
    }
  }
  return fields;
}

/** Every field must be one of `allowed`. */
export function onlyFields(fields: Field[], allowed: number[]) {
  if (!fields.every((field) => allowed.includes(field.number))) throw new Malformed("Unexpected field");
}

function single(fields: Field[], number: number): Field | undefined {
  const found = fields.filter((field) => field.number === number);
  if (found.length > 1) throw new Malformed("Repeated field");
  return found[0];
}

export function bytesOf(fields: Field[], number: number): Uint8Array | undefined {
  const field = single(fields, number);
  if (field && field.bytes === undefined) throw new Malformed("Expected bytes");
  return field?.bytes;
}

export function integerOf(fields: Field[], number: number): bigint | undefined {
  const field = single(fields, number);
  if (field && field.value === undefined) throw new Malformed("Expected a number");
  return field?.value;
}

export function allBytesOf(fields: Field[], number: number): Uint8Array[] {
  return fields.filter((field) => field.number === number).map((field) => {
    if (field.bytes === undefined) throw new Malformed("Expected bytes");
    return field.bytes;
  });
}

/** A packed list of varints, as protobuf writes repeated numbers. */
export function packed(data: Uint8Array): bigint[] {
  const values: bigint[] = [];
  let at = 0;
  while (at < data.length) {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (at >= data.length || shift >= 70n) throw new Malformed("Bad packed list");
      const byte = data[at++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) break;
    }
    values.push(value);
  }
  return values;
}

/** A safe positive integer, or throws. */
export function safeNumber(value: bigint | undefined, what: string): number {
  if (value === undefined || value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Malformed(`Bad ${what}`);
  return Number(value);
}

export function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Malformed("Text isn't UTF-8");
  }
}
