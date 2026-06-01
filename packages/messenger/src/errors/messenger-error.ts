/**
 * Root of the messenger error hierarchy (CLAUDE.md Rule 6). Never throw a plain
 * `Error`: throw a subclass of this so middlewares (e.g. the retry strategy) can
 * branch on the error type rather than on string matching.
 *
 * The concrete subclass name is assigned to `name` automatically via `new.target`,
 * so subclasses that don't change construction behaviour need no constructor.
 */
export abstract class MessengerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
