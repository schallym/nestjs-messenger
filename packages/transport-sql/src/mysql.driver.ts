import type * as mysql from 'mysql2/promise';
import {
  abortableSleep,
  loadOptionalModule,
  type MessageRow,
  type SqlDriver,
  type SqlValue,
} from './driver';
import { isMysqlTransientError } from './error-mapping';
import { withTransientRetry } from './transient-retry';

type MysqlModule = typeof mysql;
type MysqlPool = mysql.Pool;
type MysqlRowDataPacket = mysql.RowDataPacket;
type MysqlResultSetHeader = mysql.ResultSetHeader;

export interface MysqlDriverConfig {
  /** Already normalized to a `mysql:` scheme (mariadb:// is the same wire protocol). */
  readonly dsn: string;
  readonly tableName: string;
  readonly pollIntervalMs: number;
}

interface MessageRowPacket extends MysqlRowDataPacket {
  id: string;
  body: string;
  headers: string;
}

interface CountRowPacket extends MysqlRowDataPacket {
  count: number;
}

/** `mysql2` is an optional peer dependency, loaded only when a mysql DSN is used. */
function loadMysql(): MysqlModule {
  return loadOptionalModule(
    'mysql2/promise',
    "The mysql dialect requires the optional peer dependency 'mysql2'. Install it: pnpm add mysql2",
  ) as MysqlModule;
}

/**
 * MySQL/MariaDB dialect. Claims run `SELECT … FOR UPDATE SKIP LOCKED` + `UPDATE` in
 * one transaction (MySQL has no `UPDATE … RETURNING`). There is no LISTEN/NOTIFY
 * equivalent, so idle consumers poll at `pollIntervalMs`. Requires MySQL ≥ 8.0.1 or
 * MariaDB ≥ 10.6 (SKIP LOCKED).
 */
export class MysqlDriver implements SqlDriver {
  private readonly config: MysqlDriverConfig;
  private pool?: MysqlPool;

  constructor(config: MysqlDriverConfig) {
    this.config = config;
  }

  async setup(): Promise<void> {
    // LONGTEXT (plain TEXT caps at 64 KB) and utf8mb4 (emoji) are required by the
    // conformance large-payload and special-characters scenarios; DATETIME(3) keeps
    // millisecond delay precision. The inline index doubles as the claim covering index.
    await this.execute(
      `CREATE TABLE IF NOT EXISTS ${this.config.tableName} (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        body LONGTEXT NOT NULL,
        headers LONGTEXT NOT NULL,
        queue_name VARCHAR(190) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        available_at DATETIME(3) NOT NULL,
        delivered_at DATETIME(3) NULL,
        INDEX ${this.config.tableName}_claim_idx (queue_name, available_at, delivered_at, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      [],
    );
  }

  async insert(queueName: string, body: string, headers: string, delayMs: number): Promise<string> {
    const [result] = await this.db().query<MysqlResultSetHeader>(
      `INSERT INTO ${this.config.tableName} (queue_name, body, headers, created_at, available_at)
        VALUES (?, ?, ?, NOW(3), NOW(3) + INTERVAL ? MICROSECOND)`,
      [queueName, body, headers, delayMs * 1000],
    );
    return String(result.insertId);
  }

  async claimOne(
    queueName: string,
    redeliverTimeoutSeconds: number,
  ): Promise<MessageRow | undefined> {
    return withTransientRetry(async () => {
      const connection = await this.db().getConnection();
      // On failure the connection is destroyed instead of released: the server then
      // rolls back the open transaction, avoiding a second fallible ROLLBACK round-trip.
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query<MessageRowPacket[]>(
          `SELECT CAST(id AS CHAR) AS id, body, headers FROM ${this.config.tableName}
            WHERE queue_name = ? AND available_at <= NOW(3)
              AND (delivered_at IS NULL OR delivered_at < NOW(3) - INTERVAL ? SECOND)
            ORDER BY available_at, id LIMIT 1
            FOR UPDATE SKIP LOCKED`,
          [queueName, redeliverTimeoutSeconds],
        );
        const row = rows[0];
        if (row !== undefined) {
          await connection.query(
            `UPDATE ${this.config.tableName} SET delivered_at = NOW(3) WHERE id = ?`,
            [row.id],
          );
        }
        await connection.commit();
        connection.release();
        return row === undefined ? undefined : { id: row.id, body: row.body, headers: row.headers };
      } catch (error) {
        connection.destroy();
        throw error;
      }
    }, isMysqlTransientError);
  }

  async deleteById(id: string): Promise<void> {
    await withTransientRetry(
      () => this.execute(`DELETE FROM ${this.config.tableName} WHERE id = ?`, [id]),
      isMysqlTransientError,
    );
  }

  async redeliver(
    originalId: string,
    queueName: string,
    body: string,
    headers: string,
    delayMs: number,
  ): Promise<void> {
    await withTransientRetry(async () => {
      const connection = await this.db().getConnection();
      try {
        await connection.beginTransaction();
        await connection.query(
          `INSERT INTO ${this.config.tableName} (queue_name, body, headers, created_at, available_at)
            VALUES (?, ?, ?, NOW(3), NOW(3) + INTERVAL ? MICROSECOND)`,
          [queueName, body, headers, delayMs * 1000],
        );
        await connection.query(`DELETE FROM ${this.config.tableName} WHERE id = ?`, [originalId]);
        await connection.commit();
        connection.release();
      } catch (error) {
        connection.destroy();
        throw error;
      }
    }, isMysqlTransientError);
  }

  async findById(id: string): Promise<MessageRow | undefined> {
    const [rows] = await this.db().query<MessageRowPacket[]>(
      `SELECT CAST(id AS CHAR) AS id, body, headers FROM ${this.config.tableName} WHERE id = ?`,
      [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : { id: row.id, body: row.body, headers: row.headers };
  }

  async list(queueName: string, limit: number): Promise<readonly MessageRow[]> {
    const [rows] = await this.db().query<MessageRowPacket[]>(
      `SELECT CAST(id AS CHAR) AS id, body, headers FROM ${this.config.tableName}
        WHERE queue_name = ? ORDER BY available_at, id LIMIT ?`,
      [queueName, limit],
    );
    return rows.map((row) => ({ id: row.id, body: row.body, headers: row.headers }));
  }

  async count(queueName: string, redeliverTimeoutSeconds: number): Promise<number> {
    const [rows] = await this.db().query<CountRowPacket[]>(
      `SELECT COUNT(*) AS count FROM ${this.config.tableName}
        WHERE queue_name = ? AND available_at <= NOW(3)
          AND (delivered_at IS NULL OR delivered_at < NOW(3) - INTERVAL ? SECOND)`,
      [queueName, redeliverTimeoutSeconds],
    );
    // COUNT(*) always yields exactly one row; summing avoids a dead `?? 0` branch.
    return rows.reduce((total, row) => total + row.count, 0);
  }

  async waitForMessage(
    _queueName: string,
    _redeliverTimeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    await abortableSleep(this.config.pollIntervalMs, signal);
  }

  async close(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
    }
  }

  private db(): MysqlPool {
    this.pool ??= this.createPool();
    return this.pool;
  }

  private createPool(): MysqlPool {
    return loadMysql().createPool(this.config.dsn);
  }

  private async execute(sql: string, values: readonly SqlValue[]): Promise<void> {
    await this.db().query(sql, [...values]);
  }
}
