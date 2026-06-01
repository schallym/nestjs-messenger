import { Envelope } from '../envelope';
import { SerializationError } from '../errors';
import {
  BusNameStamp,
  DelayStamp,
  ErrorDetailsStamp,
  HandledStamp,
  ReceivedStamp,
  RedeliveryStamp,
  SentStamp,
  SentToFailureTransportStamp,
  type Stamp,
  type StampType,
  TransportMessageIdStamp,
} from '../stamps';
import type { EncodedEnvelope, SerializableType, Serializer } from './serializer.interface';

interface EncodedStamp {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

const MESSAGE_TYPE_HEADER = 'X-Message-Type';
const STAMPS_HEADER = 'X-Message-Stamps';

/** Built-in stamp classes are always reconstructible without explicit registration. */
const BUILT_IN_STAMPS: readonly SerializableType[] = [
  BusNameStamp,
  SentStamp,
  ReceivedStamp,
  TransportMessageIdStamp,
  DelayStamp,
  RedeliveryStamp,
  HandledStamp,
  ErrorDetailsStamp,
  SentToFailureTransportStamp,
];

/**
 * Stamps that describe a *local* delivery and must not cross the wire (Symfony's
 * `NonSendableStampInterface`). They are stripped on encode and re-applied by the
 * receiving transport/worker, so a re-sent retry never carries a stale value.
 */
const NON_SENDABLE_STAMP_TYPES: ReadonlySet<StampType> = new Set<StampType>([
  ReceivedStamp,
  TransportMessageIdStamp,
]);

/** Copy a value's own enumerable properties into a plain JSON-serialisable record. */
function toPlainData(value: object): Record<string, unknown> {
  return { ...(value as Record<string, unknown>) };
}

/**
 * Default JSON serializer. Encodes the message body as JSON and the stamps into a
 * header, reconstructing class identity on decode via a registry of known types.
 *
 * Limitation: values JSON cannot represent natively (Date, BigInt, Map, ...) do not
 * round-trip as their original type. Provide a custom {@link Serializer} if you need that.
 */
export class JsonSerializer implements Serializer {
  private readonly registry: ReadonlyMap<string, SerializableType>;

  constructor(messageTypes: readonly SerializableType[] = []) {
    const registry = new Map<string, SerializableType>();
    for (const type of [...BUILT_IN_STAMPS, ...messageTypes]) {
      registry.set(type.name, type);
    }
    this.registry = registry;
  }

  encode(envelope: Envelope): EncodedEnvelope {
    const stamps: EncodedStamp[] = [];
    for (const list of envelope.all().values()) {
      for (const stamp of list) {
        if (NON_SENDABLE_STAMP_TYPES.has(stamp.constructor as StampType)) {
          continue;
        }
        stamps.push({ type: stamp.constructor.name, data: toPlainData(stamp) });
      }
    }

    return {
      body: JSON.stringify(toPlainData(envelope.message)),
      headers: {
        [MESSAGE_TYPE_HEADER]: envelope.message.constructor.name,
        [STAMPS_HEADER]: JSON.stringify(stamps),
      },
    };
  }

  decode(encoded: EncodedEnvelope): Envelope {
    const messageType = encoded.headers[MESSAGE_TYPE_HEADER];
    if (messageType === undefined) {
      throw new SerializationError(
        `Encoded envelope is missing the "${MESSAGE_TYPE_HEADER}" header.`,
      );
    }

    const message = this.reconstruct(messageType, this.parseObject(encoded.body));
    const stamps = this.decodeStamps(encoded.headers[STAMPS_HEADER]);
    return new Envelope(message, stamps);
  }

  private decodeStamps(raw: string | undefined): Stamp[] {
    if (raw === undefined) {
      return [];
    }

    const parsed = this.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new SerializationError(`Header "${STAMPS_HEADER}" must encode an array.`);
    }

    return (parsed as readonly unknown[]).map((entry) => this.decodeStamp(entry));
  }

  private decodeStamp(entry: unknown): Stamp {
    if (typeof entry !== 'object' || entry === null) {
      throw new SerializationError('Encoded stamp must be an object.');
    }

    const record = entry as Record<string, unknown>;
    const type = record.type;
    const data = record.data;
    if (typeof type !== 'string') {
      throw new SerializationError('Encoded stamp is missing a string "type".');
    }
    if (typeof data !== 'object' || data === null) {
      throw new SerializationError('Encoded stamp is missing its "data" object.');
    }

    return this.reconstruct(type, data as Record<string, unknown>);
  }

  private reconstruct(typeName: string, data: Record<string, unknown>): object {
    const type = this.registry.get(typeName);
    if (type === undefined) {
      throw new SerializationError(`No type "${typeName}" is registered with the serializer.`);
    }

    const instance = Object.create(type.prototype) as object;
    return Object.assign(instance, data);
  }

  private parseObject(raw: string): Record<string, unknown> {
    const parsed = this.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new SerializationError('Encoded body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  }

  private parse(raw: string): unknown {
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new SerializationError('Failed to parse encoded envelope as JSON.', { cause: error });
    }
  }
}
