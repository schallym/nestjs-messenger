import type { Envelope } from '../envelope';

/**
 * A composable behaviour in the dispatch pipeline. Code before `next()` runs on
 * the way in, code after runs on the way out — the classic onion model.
 *
 * A middleware calls `next().handle(envelope, next)` at most once to continue the
 * pipeline, or returns without calling it to short-circuit.
 */
export interface Middleware {
  handle(envelope: Envelope, next: StackInterface): Promise<Envelope>;
}

/**
 * The continuation handed to a middleware. It is callable: invoking it advances
 * the pipeline by one step and returns the next {@link Middleware} to run. This
 * matches the documented usage `next().handle(envelope, next)`.
 */
export type StackInterface = () => Middleware;
