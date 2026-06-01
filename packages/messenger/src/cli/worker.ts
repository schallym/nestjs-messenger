import type { MessageBus } from '../bus';
import type { Envelope } from '../envelope';
import type { Receiver } from '../transport';

/** Stop conditions for a worker run. Any limit left undefined means "no limit". */
export interface WorkerLimits {
  /** Stop after this many messages have been processed. */
  readonly maxMessages?: number;
  /** Stop after this many milliseconds of runtime. */
  readonly maxRuntimeMs?: number;
  /** Stop once the process RSS reaches this many bytes. */
  readonly maxMemoryBytes?: number;
}

/** Optional observability callbacks. */
export interface WorkerHooks {
  readonly onHandled?: (envelope: Envelope) => void;
  readonly onError?: (error: unknown, envelope: Envelope) => void;
}

export interface WorkerStats {
  /** Number of messages pulled and settled (acked or rejected). */
  readonly processed: number;
}

/**
 * Pulls envelopes from a receiver and runs each through the bus, then settles it:
 * `ack` when the pipeline resolves (handled, retried, or routed to the failure
 * transport), `reject` when it throws an infrastructure error (see ADR-004).
 *
 * Stops when a configured limit is reached or when the provided AbortSignal fires.
 * In all cases the message currently in flight finishes first — graceful shutdown.
 */
export class Worker {
  constructor(
    private readonly receiver: Receiver,
    private readonly bus: MessageBus,
    private readonly limits: WorkerLimits = {},
    private readonly hooks: WorkerHooks = {},
  ) {}

  async run(signal: AbortSignal): Promise<WorkerStats> {
    const controller = new AbortController();
    const stopOnExternalAbort = (): void => {
      controller.abort();
    };
    signal.addEventListener('abort', stopOnExternalAbort, { once: true });
    const runtimeTimer = this.startRuntimeLimit(controller);

    let processed = 0;
    try {
      for await (const envelope of this.receiver.get(controller.signal)) {
        await this.handleOne(envelope);
        processed += 1;
        if (this.reachedLimit(processed)) {
          controller.abort();
        }
      }
    } finally {
      signal.removeEventListener('abort', stopOnExternalAbort);
      if (runtimeTimer !== undefined) {
        clearTimeout(runtimeTimer);
      }
    }
    return { processed };
  }

  /**
   * Only the outcome of `bus.dispatch` decides ack vs. reject. A failure of `ack`
   * itself (or an `onHandled` hook) is NOT caught here: it must never turn into a
   * `reject` of an already-handled message (that would double-deliver). It propagates,
   * stopping the worker and leaving the message in-flight for redelivery — at-least-once.
   */
  private async handleOne(envelope: Envelope): Promise<void> {
    let failure: { readonly error: unknown } | undefined;
    try {
      await this.bus.dispatch(envelope);
    } catch (error) {
      failure = { error };
    }

    if (failure === undefined) {
      await this.receiver.ack(envelope);
      this.hooks.onHandled?.(envelope);
    } else {
      this.hooks.onError?.(failure.error, envelope);
      await this.receiver.reject(envelope);
    }
  }

  private startRuntimeLimit(
    controller: AbortController,
  ): ReturnType<typeof setTimeout> | undefined {
    if (this.limits.maxRuntimeMs === undefined) {
      return undefined;
    }
    const timer = setTimeout(() => {
      controller.abort();
    }, this.limits.maxRuntimeMs);
    timer.unref();
    return timer;
  }

  private reachedLimit(handled: number): boolean {
    if (this.limits.maxMessages !== undefined && handled >= this.limits.maxMessages) {
      return true;
    }
    return (
      this.limits.maxMemoryBytes !== undefined &&
      process.memoryUsage().rss >= this.limits.maxMemoryBytes
    );
  }
}
