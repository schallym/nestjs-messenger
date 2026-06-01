# @schally/nestjs-messenger-transport-redis

## [0.1.3](https://github.com/schallym/nestjs-messenger/compare/nestjs-messenger-transport-redis-v0.1.2...nestjs-messenger-transport-redis-v0.1.3) (2026-06-01)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @schally/nestjs-messenger bumped to 0.1.3
  * peerDependencies
    * @schally/nestjs-messenger bumped from ^0.1.0 to ^0.1.3

## [0.1.2](https://github.com/schallym/nestjs-messenger/compare/nestjs-messenger-transport-redis-v0.1.1...nestjs-messenger-transport-redis-v0.1.2) (2026-06-01)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @schally/nestjs-messenger bumped to 0.1.2
  * peerDependencies
    * @schally/nestjs-messenger bumped from ^0.1.0 to ^0.1.2

## [0.1.1](https://github.com/schallym/nestjs-messenger/compare/nestjs-messenger-transport-redis-v0.1.0...nestjs-messenger-transport-redis-v0.1.1) (2026-06-01)


### Bug Fixes

* add contributor acknowledgment to README ([16485ef](https://github.com/schallym/nestjs-messenger/commit/16485ef2a5f8d4652a8d2b605750859773ba5ac4))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @schally/nestjs-messenger bumped to 0.1.1
  * peerDependencies
    * @schally/nestjs-messenger bumped from ^0.1.0 to ^0.1.1

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
