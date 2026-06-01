import type { Stamp, StampType } from '../stamps';

/**
 * An immutable wrapper around a message that carries typed metadata ({@link Stamp}s).
 *
 * Every mutating-looking method returns a NEW envelope; the original is untouched.
 * Stamps are identified by their constructor reference, mirroring Symfony's
 * by-class lookup — `last(BusNameStamp)` returns the most recently added stamp of
 * exactly that class.
 */
export class Envelope<TMessage extends object = object> {
  private readonly _message: TMessage;
  private readonly _stamps: readonly Stamp[];

  constructor(message: TMessage, stamps: readonly Stamp[] = []) {
    this._message = message;
    this._stamps = [...stamps];
  }

  /**
   * Wrap a message in an envelope, or merge stamps into an existing one. Idempotent
   * for already-wrapped messages, so middlewares can call it without double-wrapping.
   */
  static wrap<T extends object>(
    message: T | Envelope<T>,
    stamps: readonly Stamp[] = [],
  ): Envelope<T> {
    if (message instanceof Envelope) {
      return stamps.length > 0 ? message.with(...stamps) : message;
    }
    return new Envelope(message, stamps);
  }

  get message(): TMessage {
    return this._message;
  }

  /** Return a new envelope with the given stamps appended. */
  with(...stamps: readonly Stamp[]): Envelope<TMessage> {
    return new Envelope(this._message, [...this._stamps, ...stamps]);
  }

  /** Return a new envelope with every stamp of the given type removed. */
  withoutAll<S extends Stamp>(stampType: StampType<S>): Envelope<TMessage> {
    return new Envelope(
      this._message,
      this._stamps.filter((stamp) => stamp.constructor !== stampType),
    );
  }

  /** The most recently added stamp of the given type, or `undefined` if none. */
  last<S extends Stamp>(stampType: StampType<S>): S | undefined {
    return this._stamps.findLast((stamp): stamp is S => stamp.constructor === stampType);
  }

  /** All stamps grouped by type. */
  all(): ReadonlyMap<StampType, readonly Stamp[]>;
  /** All stamps of the given type, in insertion order. */
  all<S extends Stamp>(stampType: StampType<S>): readonly S[];
  all<S extends Stamp>(
    stampType?: StampType<S>,
  ): ReadonlyMap<StampType, readonly Stamp[]> | readonly S[] {
    if (stampType !== undefined) {
      return this._stamps.filter((stamp): stamp is S => stamp.constructor === stampType);
    }

    const grouped = new Map<StampType, Stamp[]>();
    for (const stamp of this._stamps) {
      const type = stamp.constructor as StampType;
      const existing = grouped.get(type);
      if (existing === undefined) {
        grouped.set(type, [stamp]);
      } else {
        existing.push(stamp);
      }
    }
    return grouped;
  }
}
