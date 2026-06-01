/*
 * A realistic consumer CLI entry, built exactly the way the README tells users to:
 * import the commands from the `@schally/nestjs-messenger/cli` subpath, register them as
 * providers, and run them via nest-commander's CommandFactory. The e2e spec spawns this
 * file as a real `node` process so it exercises the published package surface
 * (subpath resolution, bootstrap, argv parsing) — not just direct method calls.
 *
 * Driven by env: REDIS_DSN, ASYNC_STREAM, FAILED_STREAM. The handler prints
 * `PROCESSED:<id>` so the test can assert the worker actually ran.
 */
require('reflect-metadata');
const { Module, Injectable } = require('@nestjs/common');
const { CommandFactory } = require('nest-commander');
const { MessengerModule, MessageHandler, JsonSerializer } = require('@schally/nestjs-messenger');
const {
  ConsumeCommand,
  FailedShowCommand,
  FailedRetryCommand,
  FailedRemoveCommand,
} = require('@schally/nestjs-messenger/cli');
const { RedisStreamsTransport } = require('@schally/nestjs-messenger-transport-redis');

class PingMessage {
  constructor(id) {
    this.id = id;
  }
}

class PingHandler {
  handle(message) {
    // eslint-disable-next-line no-console
    console.log(`PROCESSED:${message.id}`);
  }
}
Injectable()(PingHandler);
MessageHandler(PingMessage)(PingHandler);

const dsn = process.env.REDIS_DSN || 'redis://localhost:6379';
const serializer = () => new JsonSerializer([PingMessage]);

// Mirror a real consumer app EXACTLY as the README documents: the application module
// owns MessengerModule.forRoot and the handlers, and a *separate* CLI module imports the
// app module and registers the command providers. The commands resolve MESSENGER_TRANSPORTS
// / MessageBus only because MessengerModule is global — this is the regression guard for
// "Nest can't resolve dependencies of the ConsumeCommand (MESSENGER_TRANSPORTS)".
class AppModule {}
Module({
  imports: [
    MessengerModule.forRoot({
      transports: {
        async: () =>
          new RedisStreamsTransport({
            dsn,
            name: 'async',
            stream: process.env.ASYNC_STREAM,
            serializer: serializer(),
            pollIntervalMs: 15,
          }),
        failed: () =>
          new RedisStreamsTransport({
            dsn,
            name: 'failed',
            stream: process.env.FAILED_STREAM,
            serializer: serializer(),
            pollIntervalMs: 15,
          }),
      },
      routing: { PingMessage: ['async'] },
      retry: { maxRetries: 1, delayMs: 10, multiplier: 1, jitter: 0 },
      failureTransport: 'failed',
    }),
  ],
  providers: [PingHandler],
})(AppModule);

class CliModule {}
Module({
  imports: [AppModule],
  providers: [ConsumeCommand, FailedShowCommand, FailedRetryCommand, FailedRemoveCommand],
})(CliModule);

async function bootstrap() {
  await CommandFactory.run(CliModule, ['warn', 'error']);
}
bootstrap().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error('CLI_ERROR:', err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
