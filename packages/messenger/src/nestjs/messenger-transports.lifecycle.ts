import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { TransportInterface } from '../transport';
import { MESSENGER_TRANSPORTS } from './messenger.tokens';

/** Closes every configured transport when the application shuts down (Rule 8). */
@Injectable()
export class MessengerTransportsLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(MESSENGER_TRANSPORTS)
    private readonly transports: ReadonlyMap<string, TransportInterface>,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.transports.values()].map((transport) => transport.close()));
  }
}
