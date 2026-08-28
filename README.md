# Native peer-frame codec

**Status:** implemented synthetic demonstration.

A deliberately small TypeScript/Node.js and C++ Node-API demonstration for length-prefixed peer messages. It shows how a native binary boundary can be wrapped in a typed incremental decoder without claiming that a microbenchmark or toy framing protocol is a production P2P stack.

## Demonstrated outcome

- Encode binary messages as unsigned 32-bit big-endian length-prefixed frames.
- Decode all complete messages from arbitrary network fragments while retaining only the incomplete tail.
- Reject oversized declared frames before buffering an unbounded payload.
- Copy native results into Node-owned `Buffer` values with explicit ownership.
- Compare native and TypeScript implementations for byte-for-byte behavioral parity.
- Measure both implementations locally instead of assuming the native boundary is faster.

## Architecture

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

The native layer is intentionally stateless. Stream state and incomplete-tail ownership remain in the TypeScript `FrameDecoder`, where lifecycle and application policy are easier to inspect. The C++ layer performs bounded binary parsing and copies decoded payloads into Node-owned buffers. This avoids unsafe external-buffer lifetime coupling in a demonstration whose goal is clarity rather than maximum throughput.

## Verification

Seven tests cover:

1. text, binary, and empty-frame round trips;
2. a stream fragmented into one-byte network chunks;
3. an incomplete trailing frame completed by a later chunk;
4. oversized declared-frame rejection;
5. a truncated stream detected at shutdown;
6. invalid decoder-limit rejection; and
7. parity against a deterministic TypeScript reference implementation.

## Run it

Prerequisites: Node.js with local Node-API headers and a C++20 compiler. The dependency-free native build script supports macOS and Linux.

```bash
npm install
npm run typecheck
npm test
npm run demo
npm run benchmark
```

The demo and benchmark emit structured JSON. Benchmark results are local microbenchmarks only and must not be presented as production latency or throughput claims.

## Repository shape

```text
native/frame_codec.cc       bounded raw Node-API implementation
scripts/build-native.mjs    dependency-free macOS/Linux compiler driver
src/index.ts                typed wrapper and incremental stream decoder
src/reference.ts            pure TypeScript behavioral reference
src/demo.ts                 fragmented peer-message walkthrough
src/benchmark.ts            native/reference measurement harness
test/                       seven deterministic verification scenarios
```

## Production changes

- Negotiate a versioned wire protocol rather than assume this framing format.
- Add transport backpressure, connection-level quotas, authentication, encryption, and peer reputation outside the codec.
- Fuzz the native parser and run AddressSanitizer/UndefinedBehaviorSanitizer in CI.
- Decide between copy and external-buffer ownership using measured workload data and a documented lifetime model.
- Add cross-platform build artifacts or node-gyp/CMake packaging only when distribution requirements are known.
- Define observability, compatibility, rollout, and malformed-peer handling before production use.

## Non-goals

This is not an employer, protocol-vendor, or client system; it does not implement peer discovery, NAT traversal, encryption, congestion control, replication, or a production network protocol. All messages and measurements are synthetic.
