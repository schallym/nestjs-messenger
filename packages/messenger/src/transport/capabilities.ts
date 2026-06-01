import type { Envelope } from '../envelope';

/** Optional: report how many messages are waiting. Powers the `messenger:stats` CLI. */
export interface MessageCountAware {
  getMessageCount(): Promise<number>;
}

/** Optional: enumerate stored messages without consuming them. Powers failure-transport inspection. */
export interface ListableReceiver {
  list(limit?: number): AsyncIterable<Envelope>;
}

/** Optional: fetch a single message by its transport id. Powers retry-by-id. */
export interface MessageRetriever {
  find(id: string): Promise<Envelope | undefined>;
}

/**
 * Capabilities are detected by duck-typing rather than declared, so the CLI can
 * degrade gracefully against transports that don't implement them. A transport
 * MUST NOT fake a capability it can't honour — it simply doesn't expose the method.
 */
export function isMessageCountAware(transport: object): transport is MessageCountAware {
  return typeof (transport as Partial<MessageCountAware>).getMessageCount === 'function';
}

export function isListableReceiver(transport: object): transport is ListableReceiver {
  return typeof (transport as Partial<ListableReceiver>).list === 'function';
}

export function isMessageRetriever(transport: object): transport is MessageRetriever {
  return typeof (transport as Partial<MessageRetriever>).find === 'function';
}
