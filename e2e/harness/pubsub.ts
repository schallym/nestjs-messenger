import { randomUUID } from 'node:crypto';
import { PubSub } from '@google-cloud/pubsub';

// Default the emulator host for local runs (`pnpm dev:brokers` maps it to 8685). CI sets
// PUBSUB_EMULATOR_HOST explicitly. Must be set before any PubSub client is constructed.
process.env.PUBSUB_EMULATOR_HOST ??= 'localhost:8685';

export const PUBSUB_PROJECT = process.env.PUBSUB_PROJECT_ID ?? 'messenger-test';

export interface PubSubNames {
  readonly topic: string;
  readonly subscription: string;
}

/** Per-test topic/subscription names so scenarios never collide on the shared emulator. */
export function uniquePubSubNames(prefix: string): PubSubNames {
  const id = randomUUID().slice(0, 8);
  return { topic: `e2e-${prefix}-${id}`, subscription: `e2e-${prefix}-sub-${id}` };
}

/** Delete a scenario's topics/subscriptions from the emulator. */
export async function cleanupPubSub(...names: readonly PubSubNames[]): Promise<void> {
  const admin = new PubSub({ projectId: PUBSUB_PROJECT });
  try {
    for (const { topic, subscription } of names) {
      await admin
        .topic(topic)
        .subscription(subscription)
        .delete()
        .catch(() => {
          /* best-effort cleanup */
        });
      await admin
        .topic(topic)
        .delete()
        .catch(() => {
          /* best-effort cleanup */
        });
    }
  } finally {
    await admin.close();
  }
}
