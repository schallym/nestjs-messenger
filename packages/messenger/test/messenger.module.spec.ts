import { Injectable, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BusNameStamp,
  type Envelope,
  HandledStamp,
  InMemoryTransport,
  MessageBus,
  MessageHandler,
  type MessageHandlerInterface,
  type Middleware,
  MessengerModule,
  type StackInterface,
} from '../src';

class GreetMessage {
  constructor(public readonly name: string) {}
}

class RoutedMessage {
  constructor(public readonly id: string) {}
}

@Injectable()
@MessageHandler(GreetMessage)
class GreetHandler implements MessageHandlerInterface<GreetMessage> {
  readonly greeted: string[] = [];

  handle(message: GreetMessage): string {
    this.greeted.push(message.name);
    return `hi ${message.name}`;
  }
}

@Injectable()
class RecordingMiddleware implements Middleware {
  calls = 0;

  handle(envelope: Envelope, next: StackInterface): Promise<Envelope> {
    this.calls += 1;
    return next().handle(envelope, next);
  }
}

describe('MessengerModule.forRoot', () => {
  let app: INestApplication;
  let bus: MessageBus;
  let asyncTransport: InMemoryTransport;

  beforeAll(async () => {
    asyncTransport = new InMemoryTransport({ name: 'async' });
    const moduleRef = await Test.createTestingModule({
      imports: [
        MessengerModule.forRoot({
          transports: { async: asyncTransport, lazy: () => new InMemoryTransport() },
          routing: { [RoutedMessage.name]: ['async'] },
          retry: { maxRetries: 3, delayMs: 10 },
          failureTransport: 'async',
          middlewares: [RecordingMiddleware],
        }),
      ],
      providers: [GreetHandler],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    bus = app.get(MessageBus);
  });

  afterAll(async () => {
    await app.close();
  });

  it('handles a non-routed message synchronously via the discovered handler', async () => {
    const result = await bus.dispatch(new GreetMessage('ada'));

    expect(app.get(GreetHandler).greeted).toContain('ada');
    expect(result.last(HandledStamp)?.result).toBe('hi ada');
    expect(result.last(BusNameStamp)?.busName).toBe('default');
  });

  it('runs user middlewares as part of the pipeline', async () => {
    const middleware = app.get(RecordingMiddleware, { strict: false });
    const before = middleware.calls;

    await bus.dispatch(new GreetMessage('grace'));

    expect(middleware.calls).toBeGreaterThan(before);
  });

  it('sends a routed message to its transport instead of handling it inline', async () => {
    await bus.dispatch(new RoutedMessage('r-1'));

    expect(await asyncTransport.getMessageCount()).toBeGreaterThanOrEqual(1);
  });
});

describe('MessengerModule.forRootAsync', () => {
  it('builds the bus from asynchronously-resolved options', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        MessengerModule.forRootAsync({
          useFactory: () => ({ busName: 'async-bus', retry: { maxRetries: 1, delayMs: 5 } }),
        }),
      ],
      providers: [GreetHandler],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const result = await app.get(MessageBus).dispatch(new GreetMessage('lin'));

    expect(result.last(BusNameStamp)?.busName).toBe('async-bus');
    expect(app.get(GreetHandler).greeted).toContain('lin');
    await app.close();
  });
});

describe('MessengerModule lifecycle and discovery errors', () => {
  it('closes every transport when the application shuts down', async () => {
    const transport = new InMemoryTransport();
    const closeSpy = jest.spyOn(transport, 'close');
    const moduleRef = await Test.createTestingModule({
      imports: [MessengerModule.forRoot({ transports: { t: transport } })],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    await app.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('fails to start when a @MessageHandler provider has no handle method', async () => {
    @Injectable()
    @MessageHandler(GreetMessage)
    class BrokenHandler {}

    const moduleRef = await Test.createTestingModule({
      imports: [MessengerModule.forRoot({})],
      providers: [BrokenHandler],
    }).compile();
    const app = moduleRef.createNestApplication();

    await expect(app.init()).rejects.toThrow(/has no handle/);
  });
});
