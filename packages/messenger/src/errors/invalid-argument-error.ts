import { MessengerError } from './messenger-error';

/** A value passed to the library is invalid (e.g. an out-of-range retry config). */
export class InvalidArgumentError extends MessengerError {}
