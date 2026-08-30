# Limitations

This repository is a length-prefixed frame codec with a native Node-API boundary. It is not a network protocol.

## Not included

- Peer discovery, NAT traversal, encryption, authentication, congestion control, or replication.
- Transport backpressure, connection-level quotas, or peer reputation.
- Packaged cross-platform addons (node-gyp/CMake artifacts) for distribution.
- Continuous AddressSanitizer/UndefinedBehaviorSanitizer and parser fuzzing in CI.

All messages and measurements are fixtures. Benchmark output must not be presented as production throughput.

## Production changes

- Negotiate a versioned wire protocol rather than assuming this framing format.
- Fuzz the native parser and run sanitizers as a CI gate; a local sanitizer run is not that gate.
- Choose copy versus external-buffer ownership from measured workload data and a documented lifetime model.
- Define observability, compatibility, rollout, and malformed-peer handling before production use.
