import { describe, expect, it } from "vitest";

import { FrameDecoder, decodeAvailable, encodeFrames } from "../src/index.js";
import {
  decodeAvailableReference,
  encodeFramesReference,
} from "../src/reference.js";

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
});
