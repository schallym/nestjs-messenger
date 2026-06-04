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
import { GooglePubSubTransport } from '@schally/nestjs-messenger-transport-google-pubsub';
import { waitUntil } from '../harness/redis';
import { cleanupPubSub, PUBSUB_PROJECT, uniquePubSubNames } from '../harness/pubsub';

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

describe('Google Pub/Sub transport: full NestJS stack', () => {
  let app: INestApplication;
  let bus: MessageBus;
  let transports: ReadonlyMap<string, TransportInterface>;
  const asyncNames = uniquePubSubNames('orders');
  const failedNames = uniquePubSubNames('failed');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MessengerModule.forRoot({
          transports: {
            async: () =>
              new GooglePubSubTransport({
                projectId: PUBSUB_PROJECT,
                topic: asyncNames.topic,
                subscription: asyncNames.subscription,
                name: 'async',
                serializer: serializer(),
                maxMessages: 5,
              }),
            failed: () =>
              new GooglePubSubTransport({
                projectId: PUBSUB_PROJECT,
                topic: failedNames.topic,
                subscription: failedNames.subscription,
                name: 'failed',
                serializer: serializer(),
              }),
          },
          routing: {
            [ProcessOrderMessage.name]: ['async'],
            [AlwaysFailsMessage.name]: ['async'],
          },
          // Pub/Sub ignores DelayStamp, so retries are immediate; the policy still bounds
          // the number of attempts before dead-lettering.
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
  }, 45_000);

  afterAll(async () => {
    await app.close();
    await cleanupPubSub(asyncNames, failedNames);
  });

  it('routes a message to Pub/Sub and a worker consumes and handles it', async () => {
    await bus.dispatch(new ProcessOrderMessage('order-1'));

    const handler = app.get(ProcessOrderHandler);
    const controller = new AbortController();
    const running = new Worker(requireTransport(transports, 'async'), bus).run(controller.signal);
    await waitUntil(() => Promise.resolve(handler.processed.includes('order-1')), 30_000);
    controller.abort();
    await running;

    expect(handler.processed).toContain('order-1');
  }, 45_000);

  it('retries a failing message then routes it to the failure transport', async () => {
    await bus.dispatch(new AlwaysFailsMessage('fail-1'));

    const handler = app.get(AlwaysFailsHandler);
    const failed = requireTransport(transports, 'failed');
    const controller = new AbortController();
    const running = new Worker(requireTransport(transports, 'async'), bus).run(controller.signal);

    let deadLettered: Envelope | undefined;
    const draining = (async () => {
      for await (const envelope of failed.get(controller.signal)) {
        deadLettered = envelope;
        await failed.ack(envelope);
        controller.abort();
      }
    })();

    await waitUntil(() => Promise.resolve(deadLettered !== undefined), 30_000);
    controller.abort();
    await Promise.allSettled([running, draining]);

    expect(handler.attempts).toBe(3); // initial attempt + 2 retries
    expect(deadLettered?.last(ErrorDetailsStamp)?.exceptionMessage).toBe('permanent failure');
    expect(deadLettered?.last(RedeliveryStamp)?.retryCount).toBe(2);
  }, 45_000);
});
