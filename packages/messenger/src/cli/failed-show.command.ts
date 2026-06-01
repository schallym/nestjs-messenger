import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { InvalidArgumentError } from '../errors';
import {
  MESSENGER_OPTIONS,
  MESSENGER_SENDERS_LOCATOR,
  MESSENGER_TRANSPORTS,
} from '../nestjs/messenger.tokens';
import type { MessengerModuleOptions } from '../nestjs/messenger.options';
import type { SendersLocator, TransportInterface } from '../transport';
import { buildFailedMessageManager } from './failed-message-manager.factory';
import { renderFailedMessageDetail, renderFailedMessageTable } from './failed-message.presenter';

interface ShowOptions {
  max?: number;
}

/**
 * `messenger:failed:show [id]` — list dead-lettered messages (no id) or show one in
 * detail (with id). Mirrors Symfony's `messenger:failed:show`: the list is a table of
 * `Id | Class | Failed at | Retries | Error`; the detail view prints the error and
 * copy-paste retry/remove hints. `--max` caps the listed rows (default 50).
 */
@Injectable()
@Command({
  name: 'messenger:failed:show',
  arguments: '[id]',
  description: 'Show one or more messages from the failure transport.',
})
export class FailedShowCommand extends CommandRunner {
  constructor(
    @Inject(MESSENGER_OPTIONS) private readonly options: MessengerModuleOptions,
    @Inject(MESSENGER_TRANSPORTS)
    private readonly transports: ReadonlyMap<string, TransportInterface>,
    @Inject(MESSENGER_SENDERS_LOCATOR) private readonly senders: SendersLocator,
  ) {
    super();
  }

  override async run(params: readonly string[], options: ShowOptions = {}): Promise<void> {
    const manager = buildFailedMessageManager(
      this.options.failureTransport,
      this.transports,
      this.senders,
    );
    const id = params[0];
    if (id === undefined) {
      const views = await manager.list(options.max ?? 50);
      this.print(renderFailedMessageTable(views));
      return;
    }
    const view = await manager.view(id);
    if (view === undefined) {
      throw new InvalidArgumentError(`No failed message with id "${id}".`);
    }
    this.print(renderFailedMessageDetail(view));
  }

  @Option({ flags: '--max <count>', description: 'Maximum number of messages to list.' })
  parseMax(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(
        `The --max option must be a positive integer, got "${value}".`,
      );
    }
    return parsed;
  }

  private print(text: string): void {
    console.log(text);
  }
}
