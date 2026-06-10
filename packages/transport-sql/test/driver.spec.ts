import { abortableSleep } from '../src/driver';
import { clampWaitMs } from '../src/postgres.driver';

describe('clampWaitMs', () => {
  it('waits the full cap when nothing is scheduled', () => {
    expect(clampWaitMs(undefined, 500)).toBe(500);
  });

  it('floors tiny (or overdue) waits at 10ms to avoid spinning', () => {
    expect(clampWaitMs(3, 500)).toBe(10);
    expect(clampWaitMs(-200, 500)).toBe(10);
  });

  it('waits until the next scheduled message when it is below the cap', () => {
    expect(clampWaitMs(120, 500)).toBe(120);
  });

  it('never exceeds the cap', () => {
    expect(clampWaitMs(9000, 500)).toBe(500);
  });
});

describe('abortableSleep', () => {
  it('resolves after the requested duration', async () => {
    const controller = new AbortController();
    const start = Date.now();
    await abortableSleep(30, controller.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it('resolves early when the signal aborts mid-sleep', async () => {
    const controller = new AbortController();
    const start = Date.now();
    const sleeping = abortableSleep(5000, controller.signal);
    setTimeout(() => {
      controller.abort();
    }, 20);
    await sleeping;
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('resolves immediately on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await abortableSleep(5000, controller.signal);
    expect(Date.now() - start).toBeLessThan(100);
  });
});
