export interface DecodeResult {
  readonly frames: Buffer[];
  readonly consumed: number;
}

export interface ValidatedFrameBatch {
  readonly frames: readonly Buffer[];
  readonly outputBytes: number;
}

export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_BATCH_BYTES = 256 * 1024 * 1024;
export const MAX_FRAMES_PER_BATCH = 16_384;

const UINT32_MAX = 0xffffffff;

export function validateMaxFrameBytes(maxFrameBytes: unknown): number {
  if (typeof maxFrameBytes !== "number") {
    throw new TypeError("maxFrameBytes must be a number.");
  }
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 0 ||
    maxFrameBytes > UINT32_MAX
  ) {
    throw new RangeError("maxFrameBytes must be an integer between 0 and 2^32-1.");
  }
  return maxFrameBytes;
}

function requireUint8Array(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array.`);
  }
  return value;
}

export function snapshotFrameBatch(frames: unknown): ValidatedFrameBatch {
  if (!Array.isArray(frames)) {
    throw new TypeError("frames must be an array.");
  }
  const frameCount = frames.length;
  if (frameCount > MAX_FRAMES_PER_BATCH) {
    throw new RangeError("The batch contains too many frames.");
  }

  const ownedFrames: Buffer[] = [];
  let outputBytes = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const frame = requireUint8Array(frames[index], `frames[${index}]`);
    const frameBytes = frame.byteLength;
    if (frameBytes > DEFAULT_MAX_FRAME_BYTES) {
      throw new RangeError("A frame exceeds the 16 MiB encoding limit.");
    }
    if (outputBytes > MAX_BATCH_BYTES - 4 - frameBytes) {
      throw new RangeError("The encoded batch exceeds the 256 MiB limit.");
    }

    // Snapshot before reading another array element. Array accessors can run
    // arbitrary JavaScript, including detaching an earlier frame's backing
    // ArrayBuffer.
    ownedFrames.push(Buffer.from(frame));
    outputBytes += 4 + frameBytes;
  }

  return { frames: ownedFrames, outputBytes };
}

export function encodeFramesReference(frames: readonly Uint8Array[]): Buffer {
  const batch = snapshotFrameBatch(frames);
  const output = Buffer.allocUnsafe(batch.outputBytes);
  let offset = 0;
  for (const frame of batch.frames) {
    output.writeUInt32BE(frame.length, offset);
    offset += 4;
    frame.copy(output, offset);
    offset += frame.length;
  }
  return output;
}

export function decodeAvailableReference(
  input: Uint8Array,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): DecodeResult {
  const checkedMaxFrameBytes = validateMaxFrameBytes(maxFrameBytes);
  const checkedInput = requireUint8Array(input, "input");
  if (checkedInput.byteLength > MAX_BATCH_BYTES + 3) {
    throw new RangeError("The decoded batch exceeds the 256 MiB limit.");
  }
  const buffer = Buffer.from(checkedInput);

  interface FrameSlice {
    readonly payloadOffset: number;
    readonly payloadBytes: number;
  }

  const slices: FrameSlice[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const frameBytes = buffer.readUInt32BE(offset);
    if (frameBytes > checkedMaxFrameBytes) {
      throw new RangeError("Frame length exceeds maxFrameBytes.");
    }
    if (
      frameBytes > MAX_BATCH_BYTES - 4 ||
      offset > MAX_BATCH_BYTES - 4 - frameBytes
    ) {
      throw new RangeError("The decoded batch exceeds the 256 MiB limit.");
    }
    if (slices.length >= MAX_FRAMES_PER_BATCH) {
      throw new RangeError("The decoded batch contains too many frames.");
    }
    if (buffer.length - offset - 4 < frameBytes) {
      break;
    }

    slices.push({ payloadOffset: offset + 4, payloadBytes: frameBytes });
    offset += 4 + frameBytes;
  }

  const decodedFrames = slices.map(({ payloadOffset, payloadBytes }) =>
    Buffer.from(buffer.subarray(payloadOffset, payloadOffset + payloadBytes)),
  );
  return { frames: decodedFrames, consumed: offset };
}
