import type { Envelope } from '../envelope';
import type { Middleware, StackInterface } from './middleware.interface';

/** Terminal of the onion: once the middleware list is exhausted, return the envelope as-is. */
const PASSTHROUGH: Middleware = {
  handle: (envelope) => Promise.resolve(envelope),
};

/**
 * Runs an ordered list of middlewares as an onion. Single-use per dispatch: each
 * call to the continuation advances an internal cursor, so a middleware that calls
 * `next()` more than once would skip a step — see the middleware-design skill.
 */
export class MiddlewareStack {
  constructor(private readonly middlewares: readonly Middleware[]) {}

  run(envelope: Envelope): Promise<Envelope> {
    let index = 0;
    const next: StackInterface = () => {
      const middleware = this.middlewares[index] ?? PASSTHROUGH;
      index += 1;
      return middleware;
    };
    return next().handle(envelope, next);
  }
}
