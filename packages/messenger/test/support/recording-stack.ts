import type { Envelope, Middleware, StackInterface } from '../../src';

/**
 * A test double for the pipeline continuation. The middleware under test calls
 * `stack().handle(envelope, stack)`; this records the envelope it received and how
 * many times it was invoked, and returns whatever the `responder` produces (by
 * default, the envelope unchanged). Use the responder to simulate a downstream that
 * adds a stamp or throws.
 */
export class RecordingStack {
  callCount = 0;
  lastEnvelope: Envelope | undefined;

  constructor(
    private readonly responder: (envelope: Envelope) => Promise<Envelope> = (envelope) =>
      Promise.resolve(envelope),
  ) {}

  readonly stack: StackInterface = () => {
    const terminal: Middleware = {
      handle: (envelope: Envelope) => {
        this.callCount += 1;
        this.lastEnvelope = envelope;
        return this.responder(envelope);
      },
    };
    return terminal;
  };
}
