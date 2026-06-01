import { InvalidArgumentError, TransportError, TransportNotFoundError } from '../errors';
import {
  FailedMessageManager,
  isListableReceiver,
  isMessageRetriever,
  type SendersLocator,
  type TransportInterface,
} from '../transport';

/**
 * Resolves the configured failure transport and wraps it in a {@link FailedMessageManager}
 * for the `messenger:failed:*` commands. Throws a typed error when the failure transport
 * is unconfigured, unregistered, or cannot list/find messages (the inspection capabilities
 * the commands rely on). v0.1 operates a single, global failure transport (see ADR-005);
 * per-transport selection (`--transport`) is deferred.
 */
export function buildFailedMessageManager(
  failureTransportName: string | undefined,
  transports: ReadonlyMap<string, TransportInterface>,
  senders: SendersLocator,
): FailedMessageManager {
  if (failureTransportName === undefined) {
    throw new InvalidArgumentError(
      'No failure transport is configured. Set `failureTransport` in MessengerModule options.',
    );
  }
  const transport = transports.get(failureTransportName);
  if (transport === undefined) {
    throw new TransportNotFoundError(
      `The configured failure transport "${failureTransportName}" is not registered.`,
    );
  }
  if (!isListableReceiver(transport) || !isMessageRetriever(transport)) {
    throw new TransportError(
      `Transport "${failureTransportName}" cannot back the messenger:failed:* commands: ` +
        'it must implement list() and find().',
    );
  }
  return new FailedMessageManager(transport, senders);
}
