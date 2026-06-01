import { parseAutoclaimReply, parseReadReply } from '../src/stream-reply';

// The real "no messages" reply from Redis (XREADGROUP returns a null bulk reply),
// built without a `null` literal (unicorn/no-null).
const nullReply = JSON.parse('null') as unknown;

describe('parseReadReply', () => {
  it('returns an empty list for a null reply (no messages)', () => {
    expect(parseReadReply(nullReply)).toStrictEqual([]);
  });

  it('parses entries and their fields from a well-formed reply', () => {
    const reply = [['stream', [['1526984818136-0', ['body', '{"a":1}', 'headers', '{}']]]]];

    const [entry] = parseReadReply(reply);

    expect(entry?.id).toBe('1526984818136-0');
    expect(entry?.fields.get('body')).toBe('{"a":1}');
    expect(entry?.fields.get('headers')).toBe('{}');
  });

  it('skips a stream element that is not an array', () => {
    expect(parseReadReply(['not-a-stream'])).toStrictEqual([]);
  });

  it('skips a stream whose entry list is not an array', () => {
    expect(parseReadReply([['stream', 0]])).toStrictEqual([]);
  });

  it('skips malformed entries (non-array, non-string id, non-array fields)', () => {
    const reply = [
      [
        'stream',
        [
          'not-an-array-entry',
          [42, ['body', 'x']], // non-string id
          ['2-0', 'not-fields'], // non-array fields
          ['3-0', ['body', 'kept']], // valid
        ],
      ],
    ];

    const entries = parseReadReply(reply);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('3-0');
    expect(entries[0]?.fields.get('body')).toBe('kept');
  });

  it('drops unpaired and non-string fields', () => {
    const reply = [['stream', [['1-0', [99, 'ignored', 'body', 'kept', 'orphan']]]]];

    const [entry] = parseReadReply(reply);

    expect(entry?.fields.get('body')).toBe('kept');
    expect(entry?.fields.has('orphan')).toBe(false);
    expect(entry?.fields.size).toBe(1);
  });
});

describe('parseAutoclaimReply', () => {
  it('returns an empty list for a null reply', () => {
    expect(parseAutoclaimReply(nullReply)).toStrictEqual([]);
  });

  it('parses the claimed entries (the second element of the reply)', () => {
    const reply = ['0-0', [['7-0', ['body', 'claimed', 'headers', '{}']]], []];

    const [entry] = parseAutoclaimReply(reply);

    expect(entry?.id).toBe('7-0');
    expect(entry?.fields.get('body')).toBe('claimed');
  });
});
