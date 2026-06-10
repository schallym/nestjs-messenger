import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  type Envelope,
  ErrorDetailsStamp,
  JsonSerializer,
  MessageBus,
  MessageHandler,
  MESSENGER_TRANSPORTS,
  MessengerModule,
  RedeliveryStamp,
  type TransportInterface,
  Worker,
} from '@schally/nestjs-messenger';
import { SqlTransport } from '@schally/nestjs-messenger-transport-sql';
import {
  cleanupMysqlQueues,
  cleanupPostgresQueues,
  MYSQL_DSN,
  POSTGRES_DSN,
  uniqueSqlQueue,
  waitUntil,
} from '../harness/sql';

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

class ProcessOrderMessage {
  constructor(public readonly orderId: string) {}
}

class AlwaysFailsMessage {
  constructor(public readonly id: string) {}
}

@Injectable()
@MessageHandler(ProcessOrderMessage)
class ProcessOrderHandler {
  readonly processed: string[] = [];
  handle(message: ProcessOrderMessage): void {
    this.processed.push(message.orderId);
  }
}

@Injectable()
@MessageHandler(AlwaysFailsMessage)
class AlwaysFailsHandler {
  attempts = 0;
  handle(): void {
    this.attempts += 1;
    throw new Error('permanent failure');
  }
}

function serializer(): JsonSerializer {
  return new JsonSerializer([ProcessOrderMessage, AlwaysFailsMessage]);
}

describe('SQL transport (postgres): full NestJS stack', () => {
  let app: INestApplication;
  let bus: MessageBus;
  let transports: ReadonlyMap<string, TransportInterface>;
  const asyncQueue = uniqueSqlQueue('orders');
  const failedQueue = uniqueSqlQueue('failed');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MessengerModule.forRoot({
          transports: {
            async: () =>
              new SqlTransport({
                dsn: POSTGRES_DSN,
                name: 'async',
                queueName: asyncQueue,
                serializer: serializer(),
                pollIntervalMs: 15,
              }),
            failed: () =>
              new SqlTransport({
                dsn: POSTGRES_DSN,
                name: 'failed',
                queueName: failedQueue,
                serializer: serializer(),
                pollIntervalMs: 15,
              }),
          },
          routing: {
            [ProcessOrderMessage.name]: ['async'],
            [AlwaysFailsMessage.name]: ['async'],
          },
          retry: { maxRetries: 2, delayMs: 20, multiplier: 2, jitter: 0 },
          failureTransport: 'failed',
        }),
      ],
      providers: [ProcessOrderHandler, AlwaysFailsHandler],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    bus = app.get(MessageBus);
    transports = app.get<ReadonlyMap<string, TransportInterface>>(MESSENGER_TRANSPORTS, {
      strict: false,
    });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await cleanupPostgresQueues(asyncQueue, failedQueue);
  });

  it('routes a message to Postgres and a worker consumes and handles it', async () => {
    await bus.dispatch(new ProcessOrderMessage('order-1'));

    const handler = app.get(ProcessOrderHandler);
    const controller = new AbortController();
    const running = new Worker(requireTransport(transports, 'async'), bus).run(controller.signal);
    await waitUntil(() => Promise.resolve(handler.processed.includes('order-1')));
    controller.abort();
    await running;

    expect(handler.processed).toContain('order-1');
  }, 30_000);

  it('retries a failing message then routes it to the failure transport', async () => {
    await bus.dispatch(new AlwaysFailsMessage('fail-1'));

    const handler = app.get(AlwaysFailsHandler);
    const failed = requireTransport(transports, 'failed');
    const controller = new AbortController();
    const running = new Worker(requireTransport(transports, 'async'), bus).run(controller.signal);

    // Drain the failure transport to capture the dead-lettered message.
    let deadLettered: Envelope | undefined;
    const draining = (async () => {
      for await (const envelope of failed.get(controller.signal)) {
        deadLettered = envelope;
        await failed.ack(envelope);
        controller.abort();
      }
    })();

    await waitUntil(() => Promise.resolve(deadLettered !== undefined));
    controller.abort();
    await Promise.allSettled([running, draining]);

    // initial attempt + 2 retries
    expect(handler.attempts).toBe(3);
    expect(deadLettered?.last(ErrorDetailsStamp)?.exceptionMessage).toBe('permanent failure');
    expect(deadLettered?.last(RedeliveryStamp)?.retryCount).toBe(2);
  }, 30_000);
});

describe('SQL transport (mysql): full NestJS stack', () => {
  let app: INestApplication;
  let bus: MessageBus;
  let transports: ReadonlyMap<string, TransportInterface>;
  const asyncQueue = uniqueSqlQueue('orders-mysql');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MessengerModule.forRoot({
          transports: {
            async: () =>
              new SqlTransport({
                dsn: MYSQL_DSN,
                name: 'async',
                queueName: asyncQueue,
                serializer: serializer(),
                pollIntervalMs: 15,
              }),
          },
          routing: { [ProcessOrderMessage.name]: ['async'] },
        }),
      ],
      providers: [ProcessOrderHandler],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    bus = app.get(MessageBus);
    transports = app.get<ReadonlyMap<string, TransportInterface>>(MESSENGER_TRANSPORTS, {
      strict: false,
    });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await cleanupMysqlQueues(asyncQueue);
  });

  it('routes a message to MySQL and a worker consumes and handles it', async () => {
    await bus.dispatch(new ProcessOrderMessage('order-mysql-1'));

    const handler = app.get(ProcessOrderHandler);
    const controller = new AbortController();
    const running = new Worker(requireTransport(transports, 'async'), bus).run(controller.signal);
    await waitUntil(() => Promise.resolve(handler.processed.includes('order-mysql-1')));
    controller.abort();
    await running;

    expect(handler.processed).toContain('order-mysql-1');
  }, 30_000);
});
