import { AddBusNameStampMiddleware, BusNameStamp, Envelope } from '../src';
import { RecordingStack } from './support/recording-stack';

class TestMessage {}

describe('AddBusNameStampMiddleware', () => {
  it('stamps the bus name and forwards to the next middleware', async () => {
    const middleware = new AddBusNameStampMiddleware('command');
    const recording = new RecordingStack();

    const result = await middleware.handle(new Envelope(new TestMessage()), recording.stack);

    expect(result.last(BusNameStamp)?.busName).toBe('command');
    expect(recording.callCount).toBe(1);
    expect(recording.lastEnvelope?.last(BusNameStamp)?.busName).toBe('command');
  });

  it('does not add a second stamp when one is already present (idempotent on redelivery)', async () => {
    const middleware = new AddBusNameStampMiddleware('command');
    const recording = new RecordingStack();
    const envelope = new Envelope(new TestMessage()).with(new BusNameStamp('original'));

    const result = await middleware.handle(envelope, recording.stack);

    expect(result.all(BusNameStamp)).toHaveLength(1);
    expect(result.last(BusNameStamp)?.busName).toBe('original');
  });
});
