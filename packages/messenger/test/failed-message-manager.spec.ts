import {
  Envelope,
  ErrorDetailsStamp,
  FailedMessageManager,
  type FailureTransport,
  InMemoryTransport,
  type Sender,
  RedeliveryStamp,
  RoutingSendersLocator,
  SentToFailureTransportStamp,
  TransportError,
  TransportNotFoundError,
} from '../src';

class OrderMessage {
  constructor(public readonly id: string) {}
}

function failedEnvelope(id: string, origin = 'async'): Envelope {
  return new Envelope(new OrderMessage(id)).with(
    new ErrorDetailsStamp('Error', `boom-${id}`),
    new RedeliveryStamp(3),
    new SentToFailureTransportStamp(origin),
  );
}

interface Setup {
  readonly manager: FailedMessageManager;
  readonly failure: InMemoryTransport;
  readonly origin: InMemoryTransport;
}

async function setup(...envelopes: readonly Envelope[]): Promise<Setup> {
  const failure = new InMemoryTransport({ name: 'failed' });
  const origin = new InMemoryTransport({ name: 'async' });
  for (const envelope of envelopes) {
    await failure.send(envelope);
  }
  const senders = new RoutingSendersLocator(
    new Map<string, Sender>([['async', origin]]),
    new Map(),
  );
  return { manager: new FailedMessageManager(failure, senders), failure, origin };
}

async function firstId(manager: FailedMessageManager): Promise<string> {
  const views = await manager.list();
  return views[0]?.id ?? '';
}

describe('FailedMessageManager', () => {
  it('lists dead-lettered messages with their error and origin details', async () => {
    const { manager } = await setup(failedEnvelope('o-1'));

    const [view, ...rest] = await manager.list();

    expect(rest).toHaveLength(0);
    expect(view?.messageType).toBe('OrderMessage');
    expect(view?.error).toBe('boom-o-1');
    expect(view?.errorClass).toBe('Error');
    expect(view?.redeliveryCount).toBe(3);
    expect(view?.failedAt).toBeInstanceOf(Date);
    expect(view?.originalTransport).toBe('async');
  });

  it('views a single message by id, and returns undefined for an unknown id', async () => {
    const { manager } = await setup(failedEnvelope('o-1'));
    const id = await firstId(manager);

    const view = await manager.view(id);
    expect(view?.error).toBe('boom-o-1');

    expect(await manager.view('nope')).toBeUndefined();
  });

  it('reports defaults for a message lacking error/redelivery/origin stamps', async () => {
    const { manager, failure } = await setup();
    await failure.send(new Envelope(new OrderMessage('bare')));

    const [view] = await manager.list();

    expect(view?.error).toBeUndefined();
    expect(view?.errorClass).toBeUndefined();
    expect(view?.redeliveryCount).toBe(0);
    expect(view?.failedAt).toBeUndefined();
    expect(view?.originalTransport).toBeUndefined();
  });

  it('retries a message: re-sends to its origin with a fresh budget and removes it', async () => {
    const { manager, failure, origin } = await setup(failedEnvelope('o-1'));
    const id = await firstId(manager);

    expect(await manager.retry(id)).toBe(true);

    expect(await origin.getMessageCount()).toBe(1);
    expect(await failure.getMessageCount()).toBe(0);

    const controller = new AbortController();
    for await (const envelope of origin.get(controller.signal)) {
      expect(envelope.last(RedeliveryStamp)).toBeUndefined(); // fresh budget
      expect(envelope.last(ErrorDetailsStamp)).toBeUndefined();
      expect(envelope.last(SentToFailureTransportStamp)).toBeUndefined();
      await origin.ack(envelope);
      controller.abort();
    }
    await origin.close();
    await failure.close();
  });

  it('returns false when retrying or removing an unknown id', async () => {
    const { manager } = await setup();
    expect(await manager.retry('nope')).toBe(false);
    expect(await manager.remove('nope')).toBe(false);
  });

  it('retries every message and returns the count', async () => {
    const { manager, failure, origin } = await setup(failedEnvelope('a'), failedEnvelope('b'));

    expect(await manager.retryAll()).toBe(2);
    expect(await origin.getMessageCount()).toBe(2);
    expect(await failure.getMessageCount()).toBe(0);
  });

  it('removes a message without retrying it', async () => {
    const { manager, failure, origin } = await setup(failedEnvelope('o-1'));
    const id = await firstId(manager);

    expect(await manager.remove(id)).toBe(true);
    expect(await failure.getMessageCount()).toBe(0);
    expect(await origin.getMessageCount()).toBe(0);
  });

  it('throws when a failed message has no origin transport stamp', async () => {
    const { manager, failure } = await setup();
    await failure.send(new Envelope(new OrderMessage('o-1')).with(new RedeliveryStamp(1)));
    const id = await firstId(manager);

    await expect(manager.retry(id)).rejects.toBeInstanceOf(TransportError);
  });

  it('throws TransportNotFoundError when the origin transport is not registered', async () => {
    const { manager } = await setup(failedEnvelope('o-1', 'ghost'));
    const id = await firstId(manager);

    await expect(manager.retry(id)).rejects.toBeInstanceOf(TransportNotFoundError);
  });

  it('throws when a listed message has no TransportMessageIdStamp', async () => {
    const stampless: FailureTransport = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async *list(): AsyncIterableIterator<Envelope> {
        yield new Envelope(new OrderMessage('no-id'));
      },
      // eslint-disable-next-line unicorn/no-useless-undefined
      find: (): Promise<Envelope | undefined> => Promise.resolve(undefined),
      ack: () => Promise.resolve(),
    };
    const senders = new RoutingSendersLocator(new Map(), new Map());
    const manager = new FailedMessageManager(stampless, senders);

    await expect(manager.list()).rejects.toBeInstanceOf(TransportError);
  });
});
