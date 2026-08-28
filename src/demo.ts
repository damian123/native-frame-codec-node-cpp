import { FrameDecoder, encodeFrames } from "./index.js";

const messages = [
  { type: "hello", peer: "tokyo-7", protocol: 1 },
  { type: "inventory", ids: ["block-104", "block-105", "block-108"] },
  { type: "ack", id: "block-108" },
];

const wireBytes = encodeFrames(
  messages.map((message) => Buffer.from(JSON.stringify(message), "utf8")),
);
const fragmentSizes = [1, 2, 7, 3, 11, 5, 19];
const decoder = new FrameDecoder(64 * 1024);
const recovered: Buffer[] = [];
let offset = 0;
let fragment = 0;

while (offset < wireBytes.length) {
  const size = fragmentSizes[fragment % fragmentSizes.length] ?? 1;
  recovered.push(...decoder.push(wireBytes.subarray(offset, offset + size)));
  offset += size;
  fragment += 1;
}
decoder.finish();

console.log(
  JSON.stringify(
    {
      event: "peer_frames_recovered",
      inputMessages: messages.length,
      outputMessages: recovered.length,
      wireBytes: wireBytes.length,
      fragments: fragment,
      pendingBytes: decoder.pendingBytes(),
      messages: recovered.map((frame) => JSON.parse(frame.toString("utf8"))),
    },
    null,
    2,
  ),
);
