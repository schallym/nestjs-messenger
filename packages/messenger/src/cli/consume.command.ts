import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { MessageBus } from '../bus';
import { InvalidArgumentError, TransportNotFoundError } from '../errors';
import { MESSENGER_TRANSPORTS } from '../nestjs/messenger.tokens';
import type { TransportInterface } from '../transport';
import { Worker, type WorkerLimits } from './worker';

interface ConsumeOptions {
  limit?: number;
  timeLimit?: number;
  memoryLimit?: number;
}

function parsePositiveInt(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(
      `The --${optionName} option must be a positive integer, got "${value}".`,
    );
  }
  return parsed;
}

function unitMultiplier(unit: string | undefined): number {
  switch (unit) {
    case 'G': {
      return 1024 ** 3;
    }
    case 'M': {
      return 1024 ** 2;
    }
    case 'K': {
      return 1024;
    }
    default: {
      return 1;
    }
  }
}

function parseMemorySize(value: string): number {
  const match = /^(\d+)([KMG]?)$/.exec(value.trim().toUpperCase());
  if (match === null) {
    throw new InvalidArgumentError(
      `The --memory-limit option must look like 128M or 1G, got "${value}".`,
    );
  }
  const [, digits, unit] = match;
  return Number(digits) * unitMultiplier(unit);
}

function toLimits(options: ConsumeOptions): WorkerLimits {
  return {
    ...(options.limit === undefined ? {} : { maxMessages: options.limit }),
    ...(options.timeLimit === undefined ? {} : { maxRuntimeMs: options.timeLimit }),
    ...(options.memoryLimit === undefined ? {} : { maxMemoryBytes: options.memoryLimit }),
  };
}

/**
 * `messenger:consume <transport>` — runs a {@link Worker} against a configured transport
 * until a limit is hit or the process is signalled. Mirrors Symfony's consume options:
 * `--limit`, `--time-limit`, `--memory-limit`. Graceful shutdown on SIGTERM/SIGINT lets
 * the in-flight message finish before exiting.
 */
@Injectable()
@Command({
  name: 'messenger:consume',
  arguments: '<transport>',
  description: 'Consume and handle messages from the named transport.',
})
export class ConsumeCommand extends CommandRunner {
  constructor(
    @Inject(MESSENGER_TRANSPORTS)
    private readonly transports: ReadonlyMap<string, TransportInterface>,
    private readonly bus: MessageBus,
  ) {
    super();
  }

  override async run(params: readonly string[], options: ConsumeOptions = {}): Promise<void> {
    const name = params[0];
    if (name === undefined) {
      throw new InvalidArgumentError('Usage: messenger:consume <transport>.');
    }
    const transport = this.transports.get(name);
    if (transport === undefined) {
      throw new TransportNotFoundError(`No transport named "${name}" is configured.`);
    }
    await this.consume(transport, options);
  }

  private async consume(transport: TransportInterface, options: ConsumeOptions): Promise<void> {
    const controller = new AbortController();
    const stop = (): void => {
      controller.abort();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    try {
      await new Worker(transport, this.bus, toLimits(options)).run(controller.signal);
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      await transport.close();
    }
  }

  @Option({ flags: '--limit <count>', description: 'Stop after processing this many messages.' })
  parseLimit(value: string): number {
    return parsePositiveInt(value, 'limit');
  }

  @Option({ flags: '--time-limit <seconds>', description: 'Stop after running this many seconds.' })
  parseTimeLimit(value: string): number {
    return parsePositiveInt(value, 'time-limit') * 1000;
  }

  @Option({
    flags: '--memory-limit <size>',
    description: 'Stop once memory usage reaches this size, e.g. 128M or 1G.',
  })
  parseMemoryLimit(value: string): number {
    return parseMemorySize(value);
  }
}
