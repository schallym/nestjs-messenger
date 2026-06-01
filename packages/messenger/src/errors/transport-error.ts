import { MessengerError } from './messenger-error';

/** A transport-level (infrastructure) failure. Distinct from application/handler errors. */
export class TransportError extends MessengerError {}

/** The broker could not be reached (connection refused, network error, auth failure). */
export class TransportConnectionError extends TransportError {}

/** The broker reports the target queue/stream/topic does not exist. */
export class TransportNotFoundError extends TransportError {}
