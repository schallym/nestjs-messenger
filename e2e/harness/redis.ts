import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

export const REDIS_DSN = process.env.REDIS_DSN ?? 'redis://localhost:6379';

/** A per-test stream name so scenarios never collide on the shared broker. */
export function uniqueStream(prefix: string): string {
  return `e2e:${prefix}:${randomUUID().slice(0, 8)}`;
}

/** Remove a scenario's streams (and their delayed sorted sets) from the shared broker. */
export async function cleanupStreams(...streams: readonly string[]): Promise<void> {
  const admin = new Redis(REDIS_DSN);
  try {
    await admin.del(...streams.flatMap((stream) => [stream, `${stream}:delayed`]));
  } finally {
    admin.disconnect();
  }
}

/** Poll a condition until it holds or the timeout elapses (no arbitrary sleeps in assertions). */
export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 25);
    });
  }
  throw new Error('waitUntil timed out');
}
