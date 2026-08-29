import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_FRAME_BYTES,
  MAX_BATCH_BYTES,
  MAX_FRAMES_PER_BATCH,
  snapshotFrameBatch,
  validateMaxFrameBytes,
  type DecodeResult,
} from "./reference.js";

interface NativeBinding {
  readonly defaultMaxFrameBytes: number;
  readonly maxBatchBytes: number;
  readonly maxFramesPerBatch: number;
  encodeFrames(frames: readonly Buffer[]): Buffer;
  decodeAvailable(input: Buffer, maxFrameBytes: number): DecodeResult;
}

const require = createRequire(import.meta.url);
const nativePath = fileURLToPath(
  new URL("../build/Release/frame_codec.node", import.meta.url),
);
const native = require(nativePath) as NativeBinding;

const expectedNativeLimits = {
  defaultMaxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
  maxBatchBytes: MAX_BATCH_BYTES,
  maxFramesPerBatch: MAX_FRAMES_PER_BATCH,
} as const;
for (const [name, expected] of Object.entries(expectedNativeLimits)) {
  if (native[name as keyof typeof expectedNativeLimits] !== expected) {
    throw new Error(`Native ${name} does not match the TypeScript limit ${expected}.`);
  }
}

function requireUint8Array(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array.`);
  }
  return value;
}

export function encodeFrames(frames: readonly Uint8Array[]): Buffer {
  return native.encodeFrames(snapshotFrameBatch(frames).frames);
}

export function decodeAvailable(
  input: Uint8Array,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): DecodeResult {
  const checkedMaxFrameBytes = validateMaxFrameBytes(maxFrameBytes);
  const checkedInput = requireUint8Array(input, "input");
  const buffer = Buffer.isBuffer(checkedInput)
    ? checkedInput
    : Buffer.from(
        checkedInput.buffer,
        checkedInput.byteOffset,
        checkedInput.byteLength,
      );
  return native.decodeAvailable(buffer, checkedMaxFrameBytes);
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);
  private pendingByteLength = 0;

  public constructor(
    private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  ) {
    validateMaxFrameBytes(maxFrameBytes);
  }

  public push(chunk: Uint8Array): readonly Buffer[] {
    const incoming = requireUint8Array(chunk, "chunk");
    if (incoming.length > 0) {
      this.append(incoming);
    }

    if (this.pendingByteLength < 4) {
      return [];
    }

    const firstFrameBytes = this.peekFirstFrameLength();
    if (firstFrameBytes > this.maxFrameBytes) {
      throw new RangeError("Frame length exceeds maxFrameBytes.");
    }
    if (firstFrameBytes > MAX_BATCH_BYTES - 4) {
      throw new RangeError("The decoded batch exceeds the 256 MiB limit.");
    }
    if (this.pendingByteLength < 4 + firstFrameBytes) {
      return [];
    }

    const available = this.pending.subarray(0, this.pendingByteLength);
    const result = native.decodeAvailable(available, this.maxFrameBytes);

    const tail = Buffer.from(available.subarray(result.consumed));
    this.pending = tail;
    this.pendingByteLength = tail.length;
    return result.frames;
  }

  public finish(): void {
    if (this.pendingByteLength !== 0) {
      throw new Error(
        `Stream ended with ${this.pendingByteLength} byte(s) of an incomplete frame.`,
      );
    }
  }

  public pendingBytes(): number {
    return this.pendingByteLength;
  }

  private peekFirstFrameLength(): number {
    return this.pending.readUInt32BE(0);
  }

  private append(incoming: Uint8Array): void {
    const requiredBytes = this.pendingByteLength + incoming.byteLength;
    if (requiredBytes > MAX_BATCH_BYTES + 3) {
      throw new RangeError("The decoded batch exceeds the 256 MiB limit.");
    }
    if (this.pending.length < requiredBytes) {
      // Geometric growth makes total prefix-copying linear in the size of a
      // fragmented frame while retaining only one backing allocation.
      let capacity = Math.max(this.pending.length, 4);
      const doubledCapacity = Math.min(capacity * 2, MAX_BATCH_BYTES);
      capacity = Math.max(requiredBytes, doubledCapacity);

      const grown = Buffer.allocUnsafe(capacity);
      this.pending.copy(grown, 0, 0, this.pendingByteLength);
      this.pending = grown;
    }

    this.pending.set(incoming, this.pendingByteLength);
    this.pendingByteLength = requiredBytes;
  }
}

export {
  DEFAULT_MAX_FRAME_BYTES,
  MAX_BATCH_BYTES,
  MAX_FRAMES_PER_BATCH,
} from "./reference.js";
