export interface DecodeResult {
  readonly frames: Buffer[];
  readonly consumed: number;
}

export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFramesReference(frames: readonly Uint8Array[]): Buffer {
  let outputBytes = 0;
  for (const frame of frames) {
    if (frame.byteLength > DEFAULT_MAX_FRAME_BYTES) {
      throw new RangeError("A frame exceeds the 16 MiB encoding limit.");
    }
    outputBytes += 4 + frame.byteLength;
  }

  const output = Buffer.allocUnsafe(outputBytes);
  let offset = 0;
  for (const frame of frames) {
    output.writeUInt32BE(frame.byteLength, offset);
    offset += 4;
    Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).copy(output, offset);
    offset += frame.byteLength;
  }
  return output;
}

export function decodeAvailableReference(
  input: Uint8Array,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
): DecodeResult {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const frames: Buffer[] = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const frameBytes = buffer.readUInt32BE(offset);
    if (frameBytes > maxFrameBytes) {
      throw new RangeError("Frame length exceeds maxFrameBytes.");
    }
    if (buffer.length - offset - 4 < frameBytes) {
      break;
    }
    frames.push(Buffer.from(buffer.subarray(offset + 4, offset + 4 + frameBytes)));
    offset += 4 + frameBytes;
  }

  return { frames, consumed: offset };
}
