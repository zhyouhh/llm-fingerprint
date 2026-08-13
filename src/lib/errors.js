// Shared error type for "the caller used this wrong".
//
// The plan's CLI 契约 pins three exit codes: 0 = ran to completion (whatever the
// verdict), 1 = runtime failure, 2 = usage error. `exitCode` rides on the error so
// a CLI's top-level catch can honour that without every script re-deciding.

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

/** Throw a UsageError. Handy in expression position. */
export function usageError(message) {
  throw new UsageError(message);
}
