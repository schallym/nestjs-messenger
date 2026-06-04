import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';

export const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');

/** A per-test topic name so scenarios never collide on the shared broker. */
export function uniqueKafkaTopic(prefix: string): string {
  return `e2e-${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Delete a scenario's topics from the broker. */
export async function cleanupKafkaTopics(...topics: readonly string[]): Promise<void> {
  const admin = new Kafka({
    clientId: 'e2e-admin',
    brokers: KAFKA_BROKERS,
    logLevel: logLevel.NOTHING,
  }).admin();
  await admin.connect();
  try {
    await admin.deleteTopics({ topics: [...topics] }).catch(() => {
      /* best-effort cleanup */
    });
  } finally {
    await admin.disconnect();
  }
}
