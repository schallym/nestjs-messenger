/**
 * Pure parsers for the (loosely-typed) nested-array replies ioredis returns for
 * `XREADGROUP` and `XAUTOCLAIM`. Kept separate from the transport so they can be
 * unit-tested with crafted replies — including malformed ones — without a broker.
 */

export interface StreamEntry {
  readonly id: string;
  readonly fields: ReadonlyMap<string, string>;
}

function toFieldMap(rawFields: readonly unknown[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (let index = 0; index + 1 < rawFields.length; index += 2) {
    const key = rawFields[index];
    const value = rawFields[index + 1];
    if (typeof key === 'string' && typeof value === 'string') {
      fields.set(key, value);
    }
  }
  return fields;
}

function parseEntry(raw: unknown): StreamEntry | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const tuple = raw as readonly unknown[];
  const id = tuple[0];
  const rawFields = tuple[1];
  if (typeof id !== 'string' || !Array.isArray(rawFields)) {
    return undefined;
  }
  return { id, fields: toFieldMap(rawFields as readonly unknown[]) };
}

function parseEntryList(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: StreamEntry[] = [];
  for (const candidate of raw as readonly unknown[]) {
    const entry = parseEntry(candidate);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return entries;
}

/** Parse an `XREADGROUP` reply: `[[streamKey, [[id, fields], …]], …] | null`. */
export function parseReadReply(reply: unknown): StreamEntry[] {
  if (!Array.isArray(reply)) {
    return [];
  }
  const entries: StreamEntry[] = [];
  for (const stream of reply as readonly unknown[]) {
    if (Array.isArray(stream)) {
      entries.push(...parseEntryList((stream as readonly unknown[])[1]));
    }
  }
  return entries;
}

/** Parse an `XAUTOCLAIM` reply: `[nextCursor, [[id, fields], …], [deletedIds]]`. */
export function parseAutoclaimReply(reply: unknown): StreamEntry[] {
  if (!Array.isArray(reply)) {
    return [];
  }
  return parseEntryList((reply as readonly unknown[])[1]);
}

/** Parse an `XRANGE` reply: a flat `[[id, fields], …]` list of entries. */
export function parseRangeReply(reply: unknown): StreamEntry[] {
  return parseEntryList(reply);
}
