import {
  Envelope,
  ErrorDetailsStamp,
  InMemoryTransport,
  InvalidArgumentError,
  RedeliveryStamp,
  RoutingSendersLocator,
  type Sender,
  SentToFailureTransportStamp,
  type TransportInterface,
  TransportError,
  TransportMessageIdStamp,
  TransportNotFoundError,
} from '../src';
import { FailedRemoveCommand, FailedRetryCommand, FailedShowCommand } from '../src/cli';

class OrderMessage {
  constructor(public readonly id: string) {}
}

function failed(id: string, origin = 'async'): Envelope {
  return new Envelope(new OrderMessage(id)).with(
    new ErrorDetailsStamp('Error', `boom-${id}`),
    new RedeliveryStamp(3),
    new SentToFailureTransportStamp(origin),
  );
}

interface Harness {
  readonly failure: InMemoryTransport;
  readonly origin: InMemoryTransport;
  readonly transports: Map<string, TransportInterface>;
  readonly senders: RoutingSendersLocator;
  readonly options: { readonly failureTransport?: string };
}

async function harness(...envelopes: readonly Envelope[]): Promise<Harness> {
  const failure = new InMemoryTransport({ name: 'failed' });
  const origin = new InMemoryTransport({ name: 'async' });
  for (const envelope of envelopes) {
    await failure.send(envelope);
  }
  const transports = new Map<string, TransportInterface>([
    ['failed', failure],
    ['async', origin],
  ]);
  const senders = new RoutingSendersLocator(
    new Map<string, Sender>([['async', origin]]),
    new Map(),
  );
  return { failure, origin, transports, senders, options: { failureTransport: 'failed' } };
}

async function collectIds(failure: InMemoryTransport): Promise<string[]> {
  const ids: string[] = [];
  for await (const envelope of failure.list()) {
    const stamp = envelope.last(TransportMessageIdStamp);
    if (stamp !== undefined) {
      ids.push(String(stamp.id));
    }
  }
  return ids;
}

let logSpy: jest.SpyInstance;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {
    /* swallow command output */
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

function output(): string {
  const calls = logSpy.mock.calls as readonly (readonly unknown[])[];
  return calls.map((call) => String(call[0])).join('\n');
}

describe('messenger:failed:* commands', () => {
  describe('failure-transport resolution', () => {
    it('throws when no failure transport is configured', async () => {
      const h = await harness();
      const command = new FailedShowCommand({}, h.transports, h.senders);
      await expect(command.run([], {})).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it('throws when the configured failure transport is not registered', async () => {
      const h = await harness();
      const command = new FailedShowCommand({ failureTransport: 'ghost' }, h.transports, h.senders);
      await expect(command.run([], {})).rejects.toBeInstanceOf(TransportNotFoundError);
    });

    it('throws when the failure transport cannot list/find', async () => {
      const h = await harness();
      const notListable = {
        send: (): Promise<Envelope> => {
          throw new Error('unused');
        },
        get: (): AsyncIterableIterator<Envelope> => {
          throw new Error('unused');
        },
        ack: () => Promise.resolve(),
        reject: () => Promise.resolve(),
        close: () => Promise.resolve(),
      } satisfies TransportInterface;
      h.transports.set('failed', notListable);
      const command = new FailedShowCommand(h.options, h.transports, h.senders);
      await expect(command.run([], {})).rejects.toBeInstanceOf(TransportError);
    });
  });

  describe('messenger:failed:show', () => {
    it('lists all failed messages as a table when no id is given', async () => {
      const h = await harness(failed('o-1'), failed('o-2'));
      const command = new FailedShowCommand(h.options, h.transports, h.senders);

      await command.run([]); // exercises the default options argument

      expect(output()).toContain('OrderMessage');
      expect(output()).toContain('boom-o-1');
      expect(output()).toContain('boom-o-2');
    });

    it('shows a single message in detail when an id is given', async () => {
      const h = await harness(failed('o-1'));
      const ids = await collectIds(h.failure);
      const id = ids[0] ?? '';
      const command = new FailedShowCommand(h.options, h.transports, h.senders);

      await command.run([id], {});

      expect(output()).toContain('messenger:failed:retry');
      expect(output()).toContain('boom-o-1');
    });

    it('throws when the id is unknown', async () => {
      const h = await harness(failed('o-1'));
      const command = new FailedShowCommand(h.options, h.transports, h.senders);
      await expect(command.run(['nope'], {})).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it('parses --max as a positive integer and rejects junk', async () => {
      const h = await harness();
      const command = new FailedShowCommand(h.options, h.transports, h.senders);
      expect(command.parseMax('5')).toBe(5);
      expect(() => command.parseMax('0')).toThrow(InvalidArgumentError);
    });

    it('caps the list using --max (default 50 path covered by no-option run)', async () => {
      const h = await harness(failed('o-1'), failed('o-2'));
      const command = new FailedShowCommand(h.options, h.transports, h.senders);
      await command.run([], { max: 1 });
      expect(output()).toContain('o-1');
      expect(output()).not.toContain('o-2');
    });
  });

  describe('messenger:failed:retry', () => {
    it('re-sends a message to its origin and removes it from the failure transport', async () => {
      const h = await harness(failed('o-1'));
      const ids = await collectIds(h.failure);
      const id = ids[0] ?? '';
      const command = new FailedRetryCommand(h.options, h.transports, h.senders);

      await command.run([id]);

      expect(output()).toContain(`Retried message "${id}"`);
      expect(await h.origin.getMessageCount()).toBe(1);
      expect(await h.failure.getMessageCount()).toBe(0);
    });

    it('reports unknown ids without throwing', async () => {
      const h = await harness();
      const command = new FailedRetryCommand(h.options, h.transports, h.senders);
      await command.run(['nope']);
      expect(output()).toContain('No failed message with id "nope"');
    });

    it('throws when no id is given (never retries everything implicitly)', async () => {
      const h = await harness(failed('o-1'));
      const command = new FailedRetryCommand(h.options, h.transports, h.senders);
      await expect(command.run([])).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });

  describe('messenger:failed:remove', () => {
    it('removes a message by id', async () => {
      const h = await harness(failed('o-1'));
      const ids = await collectIds(h.failure);
      const id = ids[0] ?? '';
      const command = new FailedRemoveCommand(h.options, h.transports, h.senders);

      await command.run([id]); // exercises the default options argument

      expect(output()).toContain(`Removed message "${id}"`);
      expect(await h.failure.getMessageCount()).toBe(0);
    });

    it('removes everything with --all and shows each with --show-messages', async () => {
      const h = await harness(failed('o-1'), failed('o-2'));
      const command = new FailedRemoveCommand(h.options, h.transports, h.senders);

      expect(command.parseAll()).toBe(true);
      expect(command.parseShowMessages()).toBe(true);
      await command.run([], { all: true, showMessages: true });

      expect(output()).toContain('messenger:failed:retry'); // detail hint printed
      expect(await h.failure.getMessageCount()).toBe(0);
    });

    it('reports an unknown id', async () => {
      const h = await harness();
      const command = new FailedRemoveCommand(h.options, h.transports, h.senders);
      await command.run(['nope'], { showMessages: true });
      expect(output()).toContain('No failed message with id "nope"');
    });

    it('throws when neither id nor --all is given', async () => {
      const h = await harness(failed('o-1'));
      const command = new FailedRemoveCommand(h.options, h.transports, h.senders);
      await expect(command.run([], {})).rejects.toBeInstanceOf(InvalidArgumentError);
    });
  });
});
