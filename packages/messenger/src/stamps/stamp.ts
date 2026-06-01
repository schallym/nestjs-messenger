/**
 * Marker interface for envelope metadata (à la Symfony's `StampInterface`).
 *
 * A stamp is any class instance attached to an {@link Envelope}. Its runtime
 * identity is its constructor, which is how the envelope groups and looks stamps
 * up — see {@link StampType}.
 */
export interface Stamp {}

/** A stamp constructor reference, used to look stamps up on an envelope by type. */
export type StampType<TStamp extends Stamp = Stamp> = abstract new (...args: never[]) => TStamp;
