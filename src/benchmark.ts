import { performance } from "node:perf_hooks";

import { decodeAvailable, encodeFrames } from "./index.js";
import { decodeAvailableReference, encodeFramesReference } from "./reference.js";

const frameCount = 512;
const frameBytes = 512;
const iterations = Number.parseInt(process.env.BENCHMARK_ITERATIONS ?? "200", 10);
if (!Number.isSafeInteger(iterations) || iterations <= 0) {
  throw new Error("BENCHMARK_ITERATIONS must be a positive integer.");
}

const frames = Array.from({ length: frameCount }, (_, index) => {
  const frame = Buffer.allocUnsafe(frameBytes);
  for (let byte = 0; byte < frame.length; byte += 1) {
    frame[byte] = (index * 31 + byte * 17) & 0xff;
  }
  return frame;
});

const nativeWire = encodeFrames(frames);
const referenceWire = encodeFramesReference(frames);
if (!nativeWire.equals(referenceWire)) {
  throw new Error("Native and reference encoders produced different wire bytes.");
}

function measure(label: string, operation: () => void): Record<string, number | string> {
  for (let warmup = 0; warmup < 20; warmup += 1) {
    operation();
  }
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    operation();
  }
  const elapsedMs = performance.now() - started;
  return {
    label,
    iterations,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    operationsPerSecond: Number(((iterations * 1000) / elapsedMs).toFixed(1)),
    mebibytesPerSecond: Number(
      ((iterations * nativeWire.length * 1000) / elapsedMs / 1024 / 1024).toFixed(1),
    ),
  };
}

const measurements = [
  measure("native_encode", () => {
    encodeFrames(frames);
  }),
  measure("typescript_encode", () => {
    encodeFramesReference(frames);
  }),
  measure("native_decode", () => {
    const result = decodeAvailable(nativeWire);
    if (result.frames.length !== frameCount || result.consumed !== nativeWire.length) {
      throw new Error("Unexpected native decode result.");
    }
  }),
  measure("typescript_decode", () => {
    const result = decodeAvailableReference(referenceWire);
    if (result.frames.length !== frameCount || result.consumed !== referenceWire.length) {
      throw new Error("Unexpected reference decode result.");
    }
  }),
];

console.log(
  JSON.stringify(
    {
      event: "frame_codec_benchmark",
      disclaimer: "Local microbenchmark only; results are not production latency claims.",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      frameCount,
      frameBytes,
      wireBytes: nativeWire.length,
      measurements,
    },
    null,
    2,
  ),
);
