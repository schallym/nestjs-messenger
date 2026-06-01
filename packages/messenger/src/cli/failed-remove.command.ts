import { Inject, Injectable } from '@nestjs/common';
import { Command, CommandRunner, Option } from 'nest-commander';
import { InvalidArgumentError } from '../errors';
import {
  MESSENGER_OPTIONS,
  MESSENGER_SENDERS_LOCATOR,
  MESSENGER_TRANSPORTS,
} from '../nestjs/messenger.tokens';
import type { MessengerModuleOptions } from '../nestjs/messenger.options';
import type { FailedMessageManager, SendersLocator, TransportInterface } from '../transport';
import { buildFailedMessageManager } from './failed-message-manager.factory';
import { renderFailedMessageDetail } from './failed-message.presenter';

interface RemoveOptions {
  all?: boolean;
  showMessages?: boolean;
}

/**
 * `messenger:failed:remove <ids...>` — permanently discard dead-lettered messages without
 * retrying them. Mirrors Symfony's `messenger:failed:remove`: `--all` removes every message,
 * `--show-messages` prints each one before deleting it.
 */
@Injectable()
@Command({
  name: 'messenger:failed:remove',
  arguments: '[ids...]',
  description: 'Remove given messages from the failure transport.',
})
export class FailedRemoveCommand extends CommandRunner {
  constructor(
    @Inject(MESSENGER_OPTIONS) private readonly options: MessengerModuleOptions,
    @Inject(MESSENGER_TRANSPORTS)
    private readonly transports: ReadonlyMap<string, TransportInterface>,
    @Inject(MESSENGER_SENDERS_LOCATOR) private readonly senders: SendersLocator,
  ) {
    super();
  }

  override async run(params: readonly string[], options: RemoveOptions = {}): Promise<void> {
    const manager = buildFailedMessageManager(
      this.options.failureTransport,
      this.transports,
      this.senders,
    );
    let ids: readonly string[] = params;
    if (options.all === true) {
      const views = await manager.list();
      ids = views.map((view) => view.id);
    }
    if (ids.length === 0) {
      throw new InvalidArgumentError('Specify at least one message id, or pass --all.');
    }
    for (const id of ids) {
      await this.removeOne(manager, id, options.showMessages === true);
    }
  }

  private async removeOne(
    manager: FailedMessageManager,
    id: string,
    showMessage: boolean,
  ): Promise<void> {
    if (showMessage) {
      const view = await manager.view(id);
      if (view !== undefined) {
        this.print(renderFailedMessageDetail(view));
      }
    }
    const removed = await manager.remove(id);
    this.print(removed ? `Removed message "${id}".` : `No failed message with id "${id}".`);
  }

  @Option({ flags: '--all', description: 'Remove every message in the failure transport.' })
  parseAll(): boolean {
    return true;
  }

  @Option({ flags: '--show-messages', description: 'Print each message before removing it.' })
  parseShowMessages(): boolean {
    return true;
  }

  private print(text: string): void {
    console.log(text);
  }
}
