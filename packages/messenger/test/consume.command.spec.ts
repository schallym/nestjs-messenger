import {
  Envelope,
  HandleMessageMiddleware,
  HandlerRegistry,
  InMemoryTransport,
  InvalidArgumentError,
  MessageBus,
  type TransportInterface,
  TransportNotFoundError,
} from '../src';
import { ConsumeCommand } from '../src/cli';

class TestMessage {
  constructor(public readonly id: string) {}
}

function commandWith(transports: Map<string, TransportInterface>, bus: MessageBus): ConsumeCommand {
  return new ConsumeCommand(transports, bus);
}

describe('ConsumeCommand', () => {
  describe('option parsing', () => {
    const command = commandWith(new Map(), new MessageBus([]));

    it('parses --limit as a positive integer', () => {
      expect(command.parseLimit('10')).toBe(10);
    });

    it.each(['0', '-1', 'abc', '1.5'])('rejects an invalid --limit (%s)', (value) => {
      expect(() => command.parseLimit(value)).toThrow(InvalidArgumentError);
    });

    it('parses --time-limit into milliseconds', () => {
      expect(command.parseTimeLimit('3')).toBe(3000);
    });

    it.each([
      ['1024', 1024],
      ['512K', 512 * 1024],
      ['128M', 128 * 1024 * 1024],
      ['1G', 1024 ** 3],
    ])('parses --memory-limit %s', (value, expected) => {
      expect(command.parseMemoryLimit(value)).toBe(expected);
    });

    it('rejects an unparseable --memory-limit', () => {
      expect(() => command.parseMemoryLimit('lots')).toThrow(InvalidArgumentError);
    });
  });

  describe('run', () => {
    it('throws when no transport name is given', async () => {
      const command = commandWith(new Map(), new MessageBus([]));
      await expect(command.run([], {})).rejects.toBeInstanceOf(InvalidArgumentError);
    });

    it('throws when the named transport is not configured', async () => {
      const command = commandWith(new Map(), new MessageBus([]));
      await expect(command.run(['missing'], {})).rejects.toBeInstanceOf(TransportNotFoundError);
    });

    it('stops and closes the transport when SIGTERM is received', async () => {
      const transport = new InMemoryTransport();
      const closeSpy = jest.spyOn(transport, 'close');
      const command = commandWith(
        new Map([['async', transport]]),
        new MessageBus([new HandleMessageMiddleware(new HandlerRegistry(), true)]),
      );

      const running = command.run(['async'], {}); // no limit: runs until signalled
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, 20);
      });
      process.emit('SIGTERM');
      await running;

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });

    it('consumes up to the limit then closes the transport', async () => {
      const handled: string[] = [];
      const registry = new HandlerRegistry();
      registry.register(TestMessage, {
        name: 'TestHandler',
        handle: (message) => {
          handled.push((message as TestMessage).id);
        },
      });
      const transport = new InMemoryTransport();
      const closeSpy = jest.spyOn(transport, 'close');
      await transport.send(new Envelope(new TestMessage('a')));
      await transport.send(new Envelope(new TestMessage('b')));
      const command = commandWith(
        new Map([['async', transport]]),
        new MessageBus([new HandleMessageMiddleware(registry)]),
      );

      // All three limits set: maxMessages (2) stops first; the time/memory limits are
      // generous and just exercise the full limit-building path.
      await command.run(['async'], { limit: 2, timeLimit: 60_000, memoryLimit: 1024 ** 3 });

      expect(handled).toStrictEqual(['a', 'b']);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
