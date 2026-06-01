import {
  Envelope,
  type MessageClass,
  ReceivedStamp,
  type Sender,
  SendMessageMiddleware,
  SentStamp,
} from '../src';
import { FakeSender, FakeSendersLocator } from './support/fake-transport';
import { RecordingStack } from './support/recording-stack';

class TestMessage {
  constructor(public readonly id: string) {}
}

function locatorRouting(
  ...destinations: readonly (readonly [string, Sender])[]
): FakeSendersLocator {
  const routes = new Map<MessageClass, readonly (readonly [string, Sender])[]>([
    [TestMessage, destinations],
  ]);
  return new FakeSendersLocator(routes);
}

describe('SendMessageMiddleware', () => {
  it('does not re-send a message received from a transport, and continues the pipeline', async () => {
    const sender = new FakeSender();
    const middleware = new SendMessageMiddleware(locatorRouting(['async', sender]));
    const recording = new RecordingStack();
    const envelope = new Envelope(new TestMessage('m-1')).with(new ReceivedStamp('async'));

    await middleware.handle(envelope, recording.stack);

    expect(sender.sent).toHaveLength(0);
    expect(recording.callCount).toBe(1);
  });

  it('sends to each routed transport with a SentStamp carrying the alias, then short-circuits', async () => {
    const high = new FakeSender('id-high');
    const low = new FakeSender('id-low');
    const middleware = new SendMessageMiddleware(locatorRouting(['high', high], ['low', low]));
    const recording = new RecordingStack();

    const result = await middleware.handle(new Envelope(new TestMessage('m-1')), recording.stack);

    expect(high.sent).toHaveLength(1);
    expect(low.sent).toHaveLength(1);
    expect(recording.callCount).toBe(0); // short-circuited: the worker will handle it
    expect(result.all(SentStamp).map((stamp) => stamp.senderAlias)).toStrictEqual(['high', 'low']);
  });

  it('handles synchronously (continues the pipeline) when the message is routed nowhere', async () => {
    const middleware = new SendMessageMiddleware(new FakeSendersLocator());
    const recording = new RecordingStack();
    const envelope = new Envelope(new TestMessage('m-1'));

    await middleware.handle(envelope, recording.stack);

    expect(recording.callCount).toBe(1);
    expect(recording.lastEnvelope).toBe(envelope);
  });
});
