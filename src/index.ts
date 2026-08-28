import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { DEFAULT_MAX_FRAME_BYTES, type DecodeResult } from "./reference.js";

interface NativeBinding {
  encodeFrames(frames: readonly Buffer[]): Buffer;
  decodeAvailable(input: Buffer, maxFrameBytes: number): DecodeResult;
}

const require = createRequire(import.meta.url);
const nativePath = fileURLToPath(
  new URL("../build/Release/frame_codec.node", import.meta.url),
);
const native = require(nativePath) as NativeBinding;

export function encodeFrames(frames: readonly Uint8Array[]): Buffer {
  const buffers = frames.map((frame) =>
    Buffer.isBuffer(frame)
      ? frame
      : Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
  );
  return native.encodeFrames(buffers);
}

export function decodeAvailable(
  input: Uint8Array,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): DecodeResult {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 0 || maxFrameBytes > 0xffffffff) {
    throw new RangeError("maxFrameBytes must be an integer between 0 and 2^32-1.");
  }
  const buffer = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return native.decodeAvailable(buffer, maxFrameBytes);
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);

  public constructor(
    private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  ) {
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes < 0 ||
      maxFrameBytes > 0xffffffff
    ) {
      throw new RangeError("maxFrameBytes must be an integer between 0 and 2^32-1.");
    }
  }

  public push(chunk: Uint8Array): readonly Buffer[] {
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const combined =
      this.pending.length === 0 ? incoming : Buffer.concat([this.pending, incoming]);
    const result = native.decodeAvailable(combined, this.maxFrameBytes);

    this.pending =
      result.consumed === combined.length
        ? Buffer.alloc(0)
        : Buffer.from(combined.subarray(result.consumed));

    return result.frames;
  }

  public finish(): void {
    if (this.pending.length !== 0) {
      throw new Error(`Stream ended with ${this.pending.length} byte(s) of an incomplete frame.`);
    }
  }

  public pendingBytes(): number {
    return this.pending.length;
  }
}

export { DEFAULT_MAX_FRAME_BYTES } from "./reference.js";
