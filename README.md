# Native peer frame codec

Length-prefixed peer messages with a C++ Node-API encoder/decoder behind a typed TypeScript stream wrapper. Complete frames are emitted as they arrive; only the incomplete tail is retained.

Portfolio project using fictional data. It is not connected to an employer, client, or production system.

```text
peer messages
     |
     v
TypeScript encodeFrames / FrameDecoder
     |
     v
raw Node-API boundary
     |
     v
C++ length-prefix encode/decode
     |
     v
Node-owned Buffer values
```

## Capabilities

- Encode binary messages as unsigned 32-bit big-endian length-prefixed frames.
- Decode complete messages from arbitrary network fragments and keep only the incomplete tail.
- Reject oversized declared frames before buffering an unbounded payload.
- Snapshot borrowed input before any later JavaScript-capable Node-API call, including re-entrant array access.
- Compare native and TypeScript implementations for byte-for-byte parity, and measure both locally instead of assuming the native path is faster.

## Run

Needs Node.js with local Node-API headers and a C++20 compiler. The native build script is dependency-free on macOS and Linux.

```bash
npm ci
npm run verify
npm run benchmark
```

`verify` type-checks, builds the native addon, runs fourteen tests, and walks a fragmented stream in `src/demo.ts`. Demo and benchmark output is structured JSON. Benchmark numbers are local microbenchmarks, not production latency claims.

## Verification

GitHub Actions on push and pull request runs `npm ci`, `npm run verify`, and checks `MANIFEST.sha256` against `scripts/build-evidence-manifest.sh`.

The tests that usually catch real bugs: one-byte network chunks, a heavily fragmented 512 KiB frame, re-entrant array access that detaches an earlier Buffer, and the exact frame-count and cumulative-byte batch caps (including zero-length-frame amplification).

## Design

The native layer is stateless. Stream state lives in the TypeScript `FrameDecoder`, where lifecycle is easier to inspect. Its accumulator grows geometrically and shrinks back to the incomplete tail after each decode.

The C++ side validates a batch before allocating JavaScript frame objects, copies borrowed data into C++-owned storage, then copies decoded payloads into Node-owned buffers. No borrowed Buffer pointer crosses an allocation-capable or re-entrant Node-API call.

Shared limits, checked at load time: 16 MiB per encoded frame, 256 MiB of wire bytes per batch, 16,384 frames per batch. Decoder limits are integers from `0` through `2^32-1`.

```text
native/frame_codec.cc       bounded raw Node-API implementation
scripts/build-native.mjs    macOS/Linux compiler driver
src/index.ts                typed wrapper and stream decoder
src/reference.ts            pure TypeScript behavioral reference
```

## Limitations

This is a framing codec, not a peer-to-peer stack. See [LIMITATIONS.md](LIMITATIONS.md).
