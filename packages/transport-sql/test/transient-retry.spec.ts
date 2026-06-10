import { withTransientRetry } from '../src/transient-retry';

const transient = (error: unknown): boolean =>
  error instanceof Error && error.message === 'deadlock';

describe('withTransientRetry', () => {
  it('resolves on the first attempt without sleeping', async () => {
    const sleeps: number[] = [];
    const result = await withTransientRetry(() => Promise.resolve('ok'), transient, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    expect(result).toBe('ok');
    expect(sleeps).toHaveLength(0);
  });

  it('retries a transient failure with the base delay (centered jitter)', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withTransientRetry(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('deadlock')) : Promise.resolve(calls);
      },
      transient,
      {
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        random: () => 0.5, // centered: zero jitter
      },
    );

    expect(result).toBe(2);
    expect(sleeps).toStrictEqual([100]);
  });

  it('doubles the delay per attempt (with -10% jitter floor) and rethrows once exhausted', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await expect(
      withTransientRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error('deadlock'));
        },
        transient,
        {
          attempts: 3,
          baseDelayMs: 10,
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
          random: () => 0, // worst-case low jitter: -10%
        },
      ),
    ).rejects.toThrow('deadlock');

    expect(calls).toBe(3);
    expect(sleeps).toStrictEqual([9, 18]); // 10 and 20 with -10% jitter
  });

  it('rethrows a non-transient failure immediately', async () => {
    let calls = 0;
    await expect(
      withTransientRetry(() => {
        calls += 1;
        return Promise.reject(new Error('syntax error'));
      }, transient),
    ).rejects.toThrow('syntax error');

    expect(calls).toBe(1);
  });

  it('uses a real backoff sleep and Math.random when nothing is injected', async () => {
    let calls = 0;
    const start = Date.now();
    const result = await withTransientRetry(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('deadlock')) : Promise.resolve('done');
    }, transient);

    expect(result).toBe('done');
    // base delay 100 ms with ±10% jitter: at least ~90 ms really elapsed
    expect(Date.now() - start).toBeGreaterThanOrEqual(85);
  });
});
