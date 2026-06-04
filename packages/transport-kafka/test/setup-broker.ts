// Default the Kafka broker for local runs (`pnpm dev:brokers`). CI overrides KAFKA_BROKERS.
process.env.KAFKA_BROKERS ??= 'localhost:9092';
