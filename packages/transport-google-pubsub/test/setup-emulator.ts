// Default the Pub/Sub emulator host for local runs (`pnpm dev:brokers` maps it to 8685).
// CI overrides PUBSUB_EMULATOR_HOST to point at its emulator service.
process.env.PUBSUB_EMULATOR_HOST ??= 'localhost:8685';
process.env.PUBSUB_PROJECT_ID ??= 'messenger-test';
