# @schally/nestjs-messenger-transport-redis

## 0.1.0

### Minor Changes

- Initial public release — v0.1.0. The reference Redis transport for
  `@schally/nestjs-messenger`, built **directly on Redis Streams** (`XADD` /
  `XREADGROUP` / `XACK` / `XAUTOCLAIM`) via `ioredis` — **not** BullMQ (see ADR-003).
  Supports DSN parsing, delayed delivery (a sorted-set buffer drained each poll), a
  stalled-message reaper, poison-message handling, and the failure-inspection
  capabilities (`list` / `find`, with ack-deletes). Validated against the shared
  12-scenario transport conformance suite run against a real Redis. Requires
  `@schally/nestjs-messenger@^0.1.0` (peer dependency).
