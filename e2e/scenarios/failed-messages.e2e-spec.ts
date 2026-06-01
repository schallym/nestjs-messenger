import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  JsonSerializer,
  type ListableReceiver,
  MessageBus,
  MessageHandler,
  MESSENGER_OPTIONS,
  MESSENGER_SENDERS_LOCATOR,
  MESSENGER_TRANSPORTS,
  type MessengerModuleOptions,
  MessengerModule,
  type SendersLocator,
  type TransportInterface,
  TransportMessageIdStamp,
  Worker,
} from '@schally/nestjs-messenger';
import {
  FailedRemoveCommand,
  FailedRetryCommand,
  FailedShowCommand,
} from '@schally/nestjs-messenger/cli';
import { RedisStreamsTransport } from '@schally/nestjs-messenger-transport-redis';
import { cleanupStreams, REDIS_DSN, uniqueStream, waitUntil } from '../harness/redis';

function requireTransport(
  map: ReadonlyMap<string, TransportInterface>,
  name: string,
): TransportInterface {
  const transport = map.get(name);
  if (transport === undefined) {
    throw new Error(`transport "${name}" is not configured`);
  }
  return transport;
}

class FlakyMessage {
  constructor(public readonly id: string) {}
}

/** A handler the test flips from failing to succeeding, to drive the retry → dead-letter → retry loop. */
@Injectable()
@MessageHandler(FlakyMessage)
class FlakyHandler {
  mode: 'fail' | 'ok' = 'fail';
  readonly processed: string[] = [];
  handle(message: FlakyMessage): void {
    if (this.mode === 'fail') {
      throw new Error('flaky failure');
    }
    this.processed.push(message.id);
  }
}

function serializer(): JsonSerializer {
  return new JsonSerializer([FlakyMessage]);
}

async function failedIds(transport: ListableReceiver): Promise<string[]> {
  const ids: string[] = [];
  for await (const envelope of transport.list()) {
    const stamp = envelope.last(TransportMessageIdStamp);
    if (stamp !== undefined) {
      ids.push(String(stamp.id));
    }
  }
  return ids;
}

describe('messenger:failed:* CLI against Redis Streams', () => {
  let app: INestApplication;
  let bus: MessageBus;
  let transports: ReadonlyMap<string, TransportInterface>;
  let show: FailedShowCommand;
  let retry: FailedRetryCommand;
  let remove: FailedRemoveCommand;
  let logSpy: jest.SpyInstance;
  const asyncStream = uniqueStream('orders');
  const failedStream = uniqueStream('failed');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MessengerModule.forRoot({
          transports: {
            async: () =>
              new RedisStreamsTransport({
                dsn: REDIS_DSN,
                name: 'async',
                stream: asyncStream,
                serializer: serializer(),
                pollIntervalMs: 15,
              }),
            failed: () =>
              new RedisStreamsTransport({
                dsn: REDIS_DSN,
                name: 'failed',
                stream: failedStream,
                serializer: serializer(),
                pollIntervalMs: 15,
              }),
          },
          routing: { [FlakyMessage.name]: ['async'] },
          retry: { maxRetries: 2, delayMs: 20, multiplier: 2, jitter: 0 },
          failureTransport: 'failed',
        }),
      ],
      providers: [FlakyHandler],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    bus = app.get(MessageBus);
    transports = app.get<ReadonlyMap<string, TransportInterface>>(MESSENGER_TRANSPORTS, {
      strict: false,
    });
    const options = app.get<MessengerModuleOptions>(MESSENGER_OPTIONS, { strict: false });
    const senders = app.get<SendersLocator>(MESSENGER_SENDERS_LOCATOR, { strict: false });
    show = new FailedShowCommand(options, transports, senders);
    retry = new FailedRetryCommand(options, transports, senders);
    remove = new FailedRemoveCommand(options, transports, senders);
  }, 30_000);

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {
      /* swallow CLI output */
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  afterAll(async () => {
    await app.close();
    await cleanupStreams(asyncStream, failedStream);
  });

  /** Run a worker over `async` until `done()` holds, then stop it cleanly. */
  async function drainAsyncUntil(done: () => Promise<boolean>): Promise<void> {
    const controller = new AbortController();
    const running = new Worker(requireTransport(transports, 'async'), bus).run(controller.signal);
    try {
      await waitUntil(done, 15_000);
    } finally {
      controller.abort();
      await running;
    }
  }

  it('dead-letters a message, shows it, retries it to success, and empties the failure transport', async () => {
    const handler = app.get(FlakyHandler);
    const failed = requireTransport(transports, 'failed') as TransportInterface & ListableReceiver;

    // Phase 1: the handler fails; the message exhausts retries and lands in `failed`.
    handler.mode = 'fail';
    await bus.dispatch(new FlakyMessage('order-1'));
    await drainAsyncUntil(async () => {
      const ids = await failedIds(failed);
      return ids.length === 1;
    });

    const [id] = await failedIds(failed);
    expect(id).toBeDefined();

    // `messenger:failed:show <id>` renders the dead-lettered message.
    await show.run([String(id)], {});
    const calls = logSpy.mock.calls as readonly (readonly unknown[])[];
    const shown = calls.map((c) => String(c[0])).join('\n');
    expect(shown).toContain('flaky failure');

    // Phase 2: the handler now succeeds; `messenger:failed:retry <id>` re-enqueues it.
    handler.mode = 'ok';
    await retry.run([String(id)]);
    expect(await failedIds(failed)).toHaveLength(0); // removed from the failure transport

    await drainAsyncUntil(() => Promise.resolve(handler.processed.includes('order-1')));
    expect(handler.processed).toContain('order-1');
  }, 60_000);

  it('removes a dead-lettered message without retrying it', async () => {
    const handler = app.get(FlakyHandler);
    const failed = requireTransport(transports, 'failed') as TransportInterface & ListableReceiver;

    handler.mode = 'fail';
    await bus.dispatch(new FlakyMessage('order-2'));
    await drainAsyncUntil(async () => {
      const ids = await failedIds(failed);
      return ids.length === 1;
    });

    const [id] = await failedIds(failed);
    await remove.run([String(id)], {});

    expect(await failedIds(failed)).toHaveLength(0);
    expect(handler.processed).not.toContain('order-2');
  }, 60_000);
});
