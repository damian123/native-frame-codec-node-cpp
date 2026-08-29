import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

import {
  FrameDecoder,
  MAX_BATCH_BYTES,
  MAX_FRAMES_PER_BATCH,
  decodeAvailable,
  encodeFrames,
} from "../src/index.js";
import {
  decodeAvailableReference,
  encodeFramesReference,
} from "../src/reference.js";

interface RawNativeBinding {
  encodeFrames(frames: readonly Buffer[]): Buffer;
  decodeAvailable(input: Buffer, maxFrameBytes: number): {
    readonly frames: Buffer[];
    readonly consumed: number;
  };
}

const require = createRequire(import.meta.url);
const rawNative = require("../build/Release/frame_codec.node") as RawNativeBinding;

describe("native frame codec", () => {
  it("round-trips text and binary frames", () => {
    const input = [
      Buffer.from("peer-hello", "utf8"),
      Buffer.from([0, 1, 2, 0, 255]),
      Buffer.alloc(0),
    ];

    const encoded = encodeFrames(input);
    const decoded = decodeAvailable(encoded);

    expect(decoded.consumed).toBe(encoded.length);
    expect(decoded.frames).toEqual(input);
  });

  it("recovers frames when every network chunk contains one byte", () => {
    const input = [Buffer.from("alpha"), Buffer.from("beta"), Buffer.from("gamma")];
    const encoded = encodeFrames(input);
    const decoder = new FrameDecoder();
    const output: Buffer[] = [];

    for (const byte of encoded) {
      output.push(...decoder.push(Buffer.from([byte])));
    }
    decoder.finish();

    expect(output).toEqual(input);
    expect(decoder.pendingBytes()).toBe(0);
  });

  it("assembles a heavily fragmented large frame with geometric growth", () => {
    const payload = Buffer.alloc(512 * 1024);
    for (let offset = 0; offset < payload.length; offset += 1) {
      payload[offset] = (offset * 29 + 17) & 0xff;
    }
    const encoded = encodeFrames([payload]);
    const decoder = new FrameDecoder();
    const concat = vi.spyOn(Buffer, "concat");
    const allocate = vi.spyOn(Buffer, "allocUnsafe");
    const output: Buffer[] = [];
    let allocationCount = 0;

    try {
      for (let offset = 0; offset < encoded.length; offset += 257) {
        output.push(...decoder.push(encoded.subarray(offset, offset + 257)));
      }
      decoder.finish();
      expect(concat).not.toHaveBeenCalled();
      allocationCount = allocate.mock.calls.length;
    } finally {
      concat.mockRestore();
      allocate.mockRestore();
    }

    expect(allocationCount).toBeLessThan(32);
    expect(output).toEqual([payload]);
  });

  it("retains only an incomplete trailing frame", () => {
    const encoded = encodeFrames([Buffer.from("complete"), Buffer.from("partial")]);
    const split = encoded.length - 3;
    const decoder = new FrameDecoder();

    const first = decoder.push(encoded.subarray(0, split));
    expect(first).toEqual([Buffer.from("complete")]);
    expect(decoder.pendingBytes()).toBeGreaterThan(0);

    const second = decoder.push(encoded.subarray(split));
    expect(second).toEqual([Buffer.from("partial")]);
    decoder.finish();
  });

  it("rejects a declared frame larger than the configured limit", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1025);

    expect(() => decodeAvailable(header, 1024)).toThrow(/exceeds maxFrameBytes/);
  });

  it("reports a truncated final frame when the stream ends", () => {
    const encoded = encodeFrames([Buffer.from("not-all-here")]);
    const decoder = new FrameDecoder();
    decoder.push(encoded.subarray(0, encoded.length - 1));

    expect(() => decoder.finish()).toThrow(/incomplete frame/);
  });

  it("rejects invalid decoder limits before entering native code", () => {
    expect(() => new FrameDecoder(-1)).toThrow(/maxFrameBytes/);
    expect(() => decodeAvailable(Buffer.alloc(0), Number.NaN)).toThrow(/maxFrameBytes/);
  });

  it("rejects every invalid numeric limit in native and reference paths", () => {
    const invalidLimits = [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0x1_0000_0000];
    for (const limit of invalidLimits) {
      expect(() => decodeAvailable(Buffer.alloc(0), limit)).toThrow(RangeError);
      expect(() => decodeAvailableReference(Buffer.alloc(0), limit)).toThrow(RangeError);
      expect(() => rawNative.decodeAvailable(Buffer.alloc(0), limit)).toThrow(RangeError);
    }

    expect(() =>
      decodeAvailableReference(Buffer.alloc(0), "1024" as unknown as number),
    ).toThrow(TypeError);
    expect(() =>
      rawNative.decodeAvailable(Buffer.alloc(0), "1024" as unknown as number),
    ).toThrow(TypeError);
  });

  it("validates TypeScript inputs at runtime", () => {
    const invalidFrames = [Buffer.from("valid"), "not-bytes"] as unknown as readonly Uint8Array[];
    expect(() => encodeFrames(invalidFrames)).toThrow(/frames\[1\].*Uint8Array/);
    expect(() => encodeFramesReference(invalidFrames)).toThrow(/frames\[1\].*Uint8Array/);
    expect(() =>
      decodeAvailableReference("not-bytes" as unknown as Uint8Array),
    ).toThrow(/input.*Uint8Array/);
  });

  it("snapshots a frame before a later array getter detaches it", () => {
    const reentrantFrames = (): Buffer[] => {
      const backing = new ArrayBuffer(4);
      const first = Buffer.from(backing);
      first.set([0xde, 0xad, 0xbe, 0xef]);
      const second = Buffer.from([0x42]);
      const frames = new Array<Buffer>(2);
      Object.defineProperty(frames, 0, {
        configurable: true,
        get: () => first,
      });
      Object.defineProperty(frames, 1, {
        configurable: true,
        get: () => {
          structuredClone(backing, { transfer: [backing] });
          return second;
        },
      });
      return frames;
    };
    const expected = Buffer.from([
      0, 0, 0, 4, 0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 1, 0x42,
    ]);

    expect(rawNative.encodeFrames(reentrantFrames())).toEqual(expected);
    expect(encodeFrames(reentrantFrames())).toEqual(expected);
    expect(encodeFramesReference(reentrantFrames())).toEqual(expected);
  });

  it("enforces the zero-length-frame batch cap before object amplification", () => {
    const atLimit = Buffer.alloc(MAX_FRAMES_PER_BATCH * 4);
    const nativeBoundary = decodeAvailable(atLimit, 0);
    const referenceBoundary = decodeAvailableReference(atLimit, 0);
    expect(nativeBoundary.frames).toHaveLength(MAX_FRAMES_PER_BATCH);
    expect(referenceBoundary.frames).toHaveLength(MAX_FRAMES_PER_BATCH);
    expect(nativeBoundary.consumed).toBe(atLimit.length);
    expect(referenceBoundary.consumed).toBe(atLimit.length);

    const overLimit = Buffer.alloc((MAX_FRAMES_PER_BATCH + 1) * 4);
    expect(() => decodeAvailable(overLimit, 0)).toThrow(/too many frames/);
    expect(() => decodeAvailableReference(overLimit, 0)).toThrow(/too many frames/);

    const tooManyFrames = new Array<Buffer>(MAX_FRAMES_PER_BATCH + 1).fill(
      Buffer.alloc(0),
    );
    expect(() => encodeFrames(tooManyFrames)).toThrow(/too many frames/);
    expect(() => encodeFramesReference(tooManyFrames)).toThrow(/too many frames/);
  });

  it("enforces the cumulative decoded-byte boundary from the header", () => {
    const atLimit = Buffer.alloc(4);
    atLimit.writeUInt32BE(MAX_BATCH_BYTES - 4);
    expect(decodeAvailable(atLimit, MAX_BATCH_BYTES - 4)).toEqual({
      frames: [],
      consumed: 0,
    });
    expect(decodeAvailableReference(atLimit, MAX_BATCH_BYTES - 4)).toEqual({
      frames: [],
      consumed: 0,
    });

    const overLimit = Buffer.alloc(4);
    overLimit.writeUInt32BE(MAX_BATCH_BYTES - 3);
    expect(() => decodeAvailable(overLimit, MAX_BATCH_BYTES - 3)).toThrow(
      /decoded batch exceeds/,
    );
    expect(() =>
      decodeAvailableReference(overLimit, MAX_BATCH_BYTES - 3),
    ).toThrow(/decoded batch exceeds/);
  });

  it("matches the TypeScript reference implementation", () => {
    let state = 0x5eed1234;
    const nextByte = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state & 0xff;
    };
    const input = Array.from({ length: 128 }, (_, index) => {
      const frame = Buffer.alloc((index * 37) % 2048);
      for (let byte = 0; byte < frame.length; byte += 1) {
        frame[byte] = nextByte();
      }
      return frame;
    });

    const nativeWire = encodeFrames(input);
    const referenceWire = encodeFramesReference(input);
    expect(nativeWire.equals(referenceWire)).toBe(true);

    const nativeDecoded = decodeAvailable(nativeWire);
    const referenceDecoded = decodeAvailableReference(referenceWire);
    expect(nativeDecoded.consumed).toBe(referenceDecoded.consumed);
    expect(nativeDecoded.frames).toEqual(referenceDecoded.frames);
  });

  it("matches the reference on complete and incomplete boundary cases", () => {
    const cases = [
      Buffer.alloc(0),
      Buffer.from([0]),
      Buffer.from([0, 0, 0]),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([0, 0, 0, 1]),
      Buffer.from([0, 0, 0, 1, 0x7f, 0, 0]),
      encodeFramesReference([Buffer.alloc(0), Buffer.from([1, 2, 3])]),
    ];

    for (const input of cases) {
      const nativeResult = decodeAvailable(input, 3);
      const referenceResult = decodeAvailableReference(input, 3);
      expect(nativeResult).toEqual(referenceResult);
    }
  });
});
