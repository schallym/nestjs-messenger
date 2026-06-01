import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { InvalidArgumentError } from '../errors';
import {
  MESSENGER_OPTIONS,
  MESSENGER_SENDERS_LOCATOR,
  MESSENGER_TRANSPORTS,
} from '../nestjs/messenger.tokens';
import type { MessengerModuleOptions } from '../nestjs/messenger.options';
import type { SendersLocator, TransportInterface } from '../transport';
import { buildFailedMessageManager } from './failed-message-manager.factory';

/**
 * `messenger:failed:retry <ids...>` — re-send the given dead-lettered messages to their
 * original transport (with a fresh retry budget) and remove them from the failure
 * transport. Mirrors Symfony's `messenger:failed:retry`, including its safety rule that
 * an id is mandatory — there is no implicit "retry everything" (see ADR-005 for why the
 * re-enqueue model differs from Symfony's in-process worker retry).
 */
@Injectable()
@Command({
  name: 'messenger:failed:retry',
  arguments: '<ids...>',
  description: 'Retry one or more messages from the failure transport.',
})
export class FailedRetryCommand extends CommandRunner {
  constructor(
    @Inject(MESSENGER_OPTIONS) private readonly options: MessengerModuleOptions,
    @Inject(MESSENGER_TRANSPORTS)
    private readonly transports: ReadonlyMap<string, TransportInterface>,
    @Inject(MESSENGER_SENDERS_LOCATOR) private readonly senders: SendersLocator,
  ) {
    super();
  }

  override async run(params: readonly string[]): Promise<void> {
    if (params.length === 0) {
      throw new InvalidArgumentError('Specify at least one message id to retry.');
    }
    const manager = buildFailedMessageManager(
      this.options.failureTransport,
      this.transports,
      this.senders,
    );
    for (const id of params) {
      const retried = await manager.retry(id);
      this.print(retried ? `Retried message "${id}".` : `No failed message with id "${id}".`);
    }
  }

  private print(text: string): void {
    console.log(text);
  }
}
