import { isListableReceiver, isMessageCountAware, isMessageRetriever } from '../src';

describe('transport capability guards', () => {
  it('detects MessageCountAware by its getMessageCount method', () => {
    expect(isMessageCountAware({ getMessageCount: () => Promise.resolve(0) })).toBe(true);
    expect(isMessageCountAware({})).toBe(false);
  });

  it('detects ListableReceiver by its list method', () => {
    expect(isListableReceiver({ list: () => [] })).toBe(true);
    expect(isListableReceiver({})).toBe(false);
  });

  it('detects MessageRetriever by its find method', () => {
    expect(isMessageRetriever({ find: () => Promise.resolve() })).toBe(true);
    expect(isMessageRetriever({})).toBe(false);
  });
});
