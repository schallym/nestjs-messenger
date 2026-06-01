import { MessengerError } from './messenger-error';

/** Encoding or decoding an envelope failed (malformed body, unknown message/stamp type). */
export class SerializationError extends MessengerError {}
