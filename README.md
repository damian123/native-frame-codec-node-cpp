# Native peer-frame codec

**Status:** implemented synthetic demonstration.

A deliberately small TypeScript/Node.js and C++ Node-API demonstration for length-prefixed peer messages. It shows how a native binary boundary can be wrapped in a typed incremental decoder without claiming that a microbenchmark or toy framing protocol is a production P2P stack.

## Demonstrated outcome

- Encode binary messages as unsigned 32-bit big-endian length-prefixed frames.
- Decode all complete messages from arbitrary network fragments while retaining only the incomplete tail.
- Reject oversized declared frames before buffering an unbounded payload.
- Snapshot borrowed input before any later JavaScript-capable Node-API call, including re-entrant array access.
- Grow incremental storage geometrically so heavily fragmented large frames are assembled in amortized linear time.
- Cap each batch at 16,384 frames and 256 MiB of wire bytes, including zero-length-frame batches.
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

The native layer is intentionally stateless. Stream state and incomplete-tail ownership remain in the TypeScript `FrameDecoder`, where lifecycle and application policy are easier to inspect. Its accumulator grows geometrically and is released or reduced to the incomplete tail after decoding, avoiding repeated whole-prefix concatenation. The C++ layer validates a batch before allocating JavaScript frame objects, snapshots borrowed data into C++-owned storage, and then copies decoded payloads into Node-owned buffers. No borrowed Buffer pointer crosses an allocation-capable or re-entrant Node-API operation.

The native binding exports its fixed limits and the TypeScript wrapper checks them against the reference constants at load time. Both implementations enforce a 16 MiB encoding limit per frame, a 256 MiB wire-byte limit per batch, a 16,384-frame limit per batch, and decoder limits that are integer values from zero through `2^32-1`.

## Verification

Fourteen tests cover:

1. text, binary, and empty-frame round trips;
2. a stream fragmented into one-byte network chunks;
3. bounded geometric allocation for a heavily fragmented 512 KiB frame;
4. an incomplete trailing frame completed by a later chunk;
5. oversized declared-frame rejection;
6. a truncated stream detected at shutdown;
7. basic invalid decoder-limit rejection;
8. native/reference rejection of negative, fractional, non-finite, non-numeric, and out-of-range limits;
9. TypeScript runtime input validation;
10. re-entrant array access that detaches an earlier Buffer backing store;
11. the exact frame-count boundary and zero-length-frame amplification rejection;
12. the exact cumulative-byte header boundary and over-limit rejection;
13. deterministic native/reference encode/decode parity; and
14. complete and incomplete boundary parity.

## Run it

Prerequisites: Node.js with local Node-API headers and a C++20 compiler. The dependency-free native build script supports macOS and Linux.

```bash
npm ci
npm run verify
npm run benchmark
```

The demo and benchmark emit structured JSON. Benchmark results are local microbenchmarks only and must not be presented as production latency or throughput claims.

## Repository shape

```text
native/frame_codec.cc       bounded raw Node-API implementation
scripts/build-native.mjs    dependency-free macOS/Linux compiler driver
src/index.ts                typed wrapper and amortized-linear stream decoder
src/reference.ts            pure TypeScript behavioral reference
src/demo.ts                 fragmented peer-message walkthrough
src/benchmark.ts            native/reference measurement harness
test/                       fourteen deterministic verification scenarios
```

## Production changes

- Negotiate a versioned wire protocol rather than assume this framing format.
- Add transport backpressure, connection-level quotas, authentication, encryption, and peer reputation outside the codec.
- Fuzz the native parser and run AddressSanitizer/UndefinedBehaviorSanitizer continuously in CI; local sanitizer success is not a substitute for that gate.
- Decide between copy and external-buffer ownership using measured workload data and a documented lifetime model.
- Add cross-platform build artifacts or node-gyp/CMake packaging only when distribution requirements are known.
- Define observability, compatibility, rollout, and malformed-peer handling before production use.

## Non-goals

This is not an employer, protocol-vendor, or client system; it does not implement peer discovery, NAT traversal, encryption, congestion control, replication, or a production network protocol. All messages and measurements are synthetic.

## Provenance

Artifact owner: Lars Schouw. Repository account: [`damian123`](https://github.com/damian123). Commits may use the display name Damian; `EVIDENCE.json` records this mapping explicitly.
