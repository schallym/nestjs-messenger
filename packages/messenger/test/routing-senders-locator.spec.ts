import { Envelope, type Sender, RoutingSendersLocator } from '../src';
import { FakeSender } from './support/fake-transport';

class OrderMessage {
  constructor(public readonly id: string) {}
}
class OtherMessage {}

describe('RoutingSendersLocator', () => {
  it('yields the senders a message is routed to, paired with their alias', () => {
    const high = new FakeSender();
    const low = new FakeSender();
    const senders = new Map<string, Sender>([
      ['high', high],
      ['low', low],
    ]);
    const routing = new Map<string, readonly string[]>([['OrderMessage', ['high', 'low']]]);
    const locator = new RoutingSendersLocator(senders, routing);

    const resolved = [...locator.getSenders(new Envelope(new OrderMessage('o-1')))];

    expect(resolved).toStrictEqual([
      ['high', high],
      ['low', low],
    ]);
  });

  it('yields nothing for a message that is not in the routing table', () => {
    const locator = new RoutingSendersLocator(new Map(), new Map());
    expect([...locator.getSenders(new Envelope(new OtherMessage()))]).toStrictEqual([]);
  });

  it('skips routed aliases that have no matching transport', () => {
    const known = new FakeSender();
    const senders = new Map<string, Sender>([['known', known]]);
    const routing = new Map<string, readonly string[]>([['OrderMessage', ['known', 'missing']]]);
    const locator = new RoutingSendersLocator(senders, routing);

    const resolved = [...locator.getSenders(new Envelope(new OrderMessage('o-1')))];

    expect(resolved).toStrictEqual([['known', known]]);
  });

  it('resolves a sender by alias, or undefined when unknown', () => {
    const sender = new FakeSender();
    const locator = new RoutingSendersLocator(new Map([['async', sender]]), new Map());

    expect(locator.getSenderByAlias('async')).toBe(sender);
    expect(locator.getSenderByAlias('nope')).toBeUndefined();
  });
});
