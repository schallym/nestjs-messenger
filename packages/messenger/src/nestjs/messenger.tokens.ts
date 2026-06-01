/** DI token carrying the resolved {@link MessengerModuleOptions}. */
export const MESSENGER_OPTIONS = 'MESSENGER_OPTIONS';

/** DI token carrying the `Map<string, TransportInterface>` built from the config. */
export const MESSENGER_TRANSPORTS = 'MESSENGER_TRANSPORTS';

/** DI token carrying the `SendersLocator` built from transports + routing. */
export const MESSENGER_SENDERS_LOCATOR = 'MESSENGER_SENDERS_LOCATOR';
