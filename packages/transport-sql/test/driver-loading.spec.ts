import { Envelope } from '@schally/nestjs-messenger';
import { SqlTransport } from '../src';

/**
 * `pg` and `mysql2` are optional peer dependencies: using a dialect without its driver
 * installed must fail with a typed, actionable error — not a bare MODULE_NOT_FOUND.
 * The drivers load their module lazily (first use), so mocking the registry BEFORE the
 * first send simulates the missing package; nothing in this file requires the real ones.
 */
describe('optional driver dependency missing', () => {
  afterEach(() => {
    jest.dontMock('pg');
    jest.dontMock('mysql2/promise');
  });

  it('surfaces a typed error naming pg when the postgres dialect is used without it', async () => {
    jest.doMock('pg', () => {
      throw Object.assign(new Error("Cannot find module 'pg'"), { code: 'MODULE_NOT_FOUND' });
    });

    const transport = new SqlTransport({ dsn: 'postgresql://nobody@localhost:5432/none' });
    await expect(transport.send(new Envelope({ ping: true }))).rejects.toThrow(
      /optional peer dependency 'pg'/,
    );
    await transport.close();
  });

  it('surfaces a typed error naming mysql2 when the mysql dialect is used without it', async () => {
    jest.doMock('mysql2/promise', () => {
      throw Object.assign(new Error("Cannot find module 'mysql2'"), { code: 'MODULE_NOT_FOUND' });
    });

    const transport = new SqlTransport({ dsn: 'mysql://nobody@localhost:3306/none' });
    await expect(transport.send(new Envelope({ ping: true }))).rejects.toThrow(
      /optional peer dependency 'mysql2'/,
    );
    await transport.close();
  });
});
