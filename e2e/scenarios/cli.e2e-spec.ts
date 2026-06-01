import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  Envelope,
  ErrorDetailsStamp,
  JsonSerializer,
  RedeliveryStamp,
  SentToFailureTransportStamp,
} from '@schally/nestjs-messenger';
import { RedisStreamsTransport } from '@schally/nestjs-messenger-transport-redis';
import { Redis } from 'ioredis';
import { cleanupStreams, REDIS_DSN, uniqueStream } from '../harness/redis';

// The message class the fixture CLI also defines (matched by constructor name on the wire).
class PingMessage {
  constructor(public readonly id: string) {}
}

const CLI = path.join(__dirname, '..', 'fixtures', 'messenger-cli.cjs');

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn the fixture CLI as a real node process — exercises subpath resolution + bootstrap + argv. */
function runCli(
  args: readonly string[],
  streams: { async: string; failed: string },
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: {
          ...process.env,
          REDIS_DSN,
          ASYNC_STREAM: streams.async,
          FAILED_STREAM: streams.failed,
        },
        timeout: 25_000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function makeTransport(name: string, stream: string): RedisStreamsTransport {
  return new RedisStreamsTransport({
    dsn: REDIS_DSN,
    name,
    stream,
    serializer: new JsonSerializer([PingMessage]),
    pollIntervalMs: 15,
  });
}

async function xlen(stream: string): Promise<number> {
  const admin = new Redis(REDIS_DSN);
  try {
    return await admin.xlen(stream);
  } finally {
    admin.disconnect();
  }
}

describe('CLI (spawned node process, real Redis)', () => {
  let asyncStream: string;
  let failedStream: string;
  let streams: { async: string; failed: string };

  beforeEach(() => {
    asyncStream = uniqueStream('cli-async');
    failedStream = uniqueStream('cli-failed');
    streams = { async: asyncStream, failed: failedStream };
  });

  afterEach(async () => {
    await cleanupStreams(asyncStream, failedStream);
  });

  it('messenger:consume drains a routed message and runs the handler', async () => {
    const transport = makeTransport('async', asyncStream);
    await transport.send(new Envelope(new PingMessage('ping-1')));
    await transport.close();

    const result = await runCli(['messenger:consume', 'async', '--limit=1'], streams);

    expect(result.stderr).not.toContain('CLI_ERROR');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PROCESSED:ping-1');
  }, 40_000);

  it('messenger:failed:show lists a dead-lettered message', async () => {
    const failed = makeTransport('failed', failedStream);
    await failed.send(
      new Envelope(new PingMessage('ping-fail')).with(
        new ErrorDetailsStamp('Error', 'kaboom'),
        new RedeliveryStamp(2),
        new SentToFailureTransportStamp('async'),
      ),
    );
    await failed.close();

    const result = await runCli(['messenger:failed:show'], streams);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PingMessage');
    expect(result.stdout).toContain('kaboom');
  }, 40_000);

  it('messenger:failed:remove --all empties the failure transport', async () => {
    const failed = makeTransport('failed', failedStream);
    await failed.send(
      new Envelope(new PingMessage('ping-fail')).with(
        new ErrorDetailsStamp('Error', 'kaboom'),
        new SentToFailureTransportStamp('async'),
      ),
    );
    await failed.close();
    expect(await xlen(failedStream)).toBe(1);

    const result = await runCli(['messenger:failed:remove', '--all'], streams);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed message');
    expect(await xlen(failedStream)).toBe(0);
  }, 40_000);

  it('messenger:failed:remove --all on an empty transport is a no-op, not an error', async () => {
    // The exact scenario a user hits running --all before anything has failed.
    const result = await runCli(['messenger:failed:remove', '--all'], streams);

    expect(result.stderr).not.toContain('InvalidArgumentError');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No failed messages.');
  }, 40_000);

  it('exits non-zero on an unknown command', async () => {
    const result = await runCli(['messenger:bogus'], streams);
    expect(result.code).not.toBe(0);
  }, 40_000);
});
