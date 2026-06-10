import { randomUUID } from 'node:crypto';
import { createPool } from 'mysql2/promise';
import { Pool } from 'pg';

export const POSTGRES_DSN =
  process.env.POSTGRES_DSN ?? 'postgresql://messenger:messenger@localhost:5432/messenger';
export const MYSQL_DSN =
  process.env.MYSQL_DSN ?? 'mysql://messenger:messenger@localhost:3306/messenger';

/** A per-test queue name so scenarios never collide on the shared databases. */
export function uniqueSqlQueue(prefix: string): string {
  return `e2e-${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Remove a scenario's queues from the shared Postgres database (best-effort). */
export async function cleanupPostgresQueues(...queueNames: readonly string[]): Promise<void> {
  const admin = new Pool({ connectionString: POSTGRES_DSN, max: 1 });
  try {
    for (const queueName of queueNames) {
      try {
        await admin.query('DELETE FROM messenger_messages WHERE queue_name = $1', [queueName]);
      } catch {
        // best-effort: the table may not exist when a scenario never sent anything
      }
    }
  } finally {
    await admin.end();
  }
}

/** Remove a scenario's queues from the shared MySQL database (best-effort). */
export async function cleanupMysqlQueues(...queueNames: readonly string[]): Promise<void> {
  const admin = createPool(MYSQL_DSN);
  try {
    for (const queueName of queueNames) {
      try {
        await admin.query('DELETE FROM messenger_messages WHERE queue_name = ?', [queueName]);
      } catch {
        // best-effort: the table may not exist when a scenario never sent anything
      }
    }
  } finally {
    await admin.end();
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
