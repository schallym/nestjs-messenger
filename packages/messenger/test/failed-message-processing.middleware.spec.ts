import {
  Envelope,
  FailedMessageProcessingMiddleware,
  ReceivedStamp,
  SentToFailureTransportStamp,
} from '../src';
import { RecordingStack } from './support/recording-stack';

class TestMessage {}

describe('FailedMessageProcessingMiddleware', () => {
  const middleware = new FailedMessageProcessingMiddleware();

  it('passes through untouched when the message is not from the failure transport', async () => {
    const recording = new RecordingStack();
    const envelope = new Envelope(new TestMessage()).with(new ReceivedStamp('failed'));

    await middleware.handle(envelope, recording.stack);

    expect(recording.lastEnvelope).toBe(envelope);
  });

  it('restores the original receiver when reprocessing a failed message', async () => {
    const recording = new RecordingStack();
    const envelope = new Envelope(new TestMessage())
      .with(new ReceivedStamp('failed'))
      .with(new SentToFailureTransportStamp('async'));

    await middleware.handle(envelope, recording.stack);

    const received = recording.lastEnvelope?.all(ReceivedStamp) ?? [];
    expect(received).toHaveLength(1);
    expect(received[0]?.transportName).toBe('async');
  });
});
