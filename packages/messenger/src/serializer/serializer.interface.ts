import type { Envelope } from '../envelope';

/** The wire form of an envelope: an opaque body string plus string headers. */
export interface EncodedEnvelope {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Encodes envelopes to and from a transport-friendly wire form. Transports MUST
 * go through the configured serializer rather than calling `JSON.stringify`
 * directly, so users can swap in custom handling (Date, BigInt, encryption, ...).
 */
export interface Serializer {
  encode(envelope: Envelope): EncodedEnvelope;
  decode(encoded: EncodedEnvelope): Envelope;
}

/**
 * A constructable class the serializer can rebuild instances of by hydrating JSON
 * data onto its prototype. Both message classes and stamp classes qualify; the
 * constructor is not invoked during reconstruction.
 */
export interface SerializableType {
  readonly name: string;
  readonly prototype: object;
  new (...args: never[]): object;
}
