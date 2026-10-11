/** Stable machine-readable error codes shared by local and remote layers. */
export type AppErrorCode =
  | "not_found"
  | "version_conflict"
  | "validation"
  | "invalid_parent"
  | "cycle"
  | "storage"
  | "network"
  | "unauthorized"
  | "forbidden"
  | "quota_exceeded"
  | "import_invalid"
  | "stale_checkpoint"
  | "unsupported";

export interface AppErrorOptions {
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Base class for every error the application raises deliberately. Errors that
 * cross a boundary (IPC, HTTP, worker messages) are reconstructed with
 * `toJSON`/`fromJSON` so a code and a recovery path survive serialization.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = options.details ?? {};
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Required for `instanceof` to keep working after targeting ES2022 output
    // that downlevels class fields.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): { code: AppErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }

  static fromJSON(value: unknown): AppError {
    if (
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      "message" in value &&
      typeof (value as { message: unknown }).message === "string"
    ) {
      const v = value as { code: AppErrorCode; message: string; details?: Record<string, unknown> };
      return new AppError(v.code, v.message, { details: v.details ?? {} });
    }
    return new AppError("storage", "Unknown error");
  }
}

export class NotFoundError extends AppError {
  constructor(what: string, id: string) {
    super("not_found", `${what} not found: ${id}`, { details: { id } });
  }
}

/**
 * Raised when a write is attempted against a stale `localVersion`. This is the
 * guard that stops one writer from silently clobbering another.
 */
export class VersionConflictError extends AppError {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super("version_conflict", `Stale write: expected version ${expected}, found ${actual}`, {
      details: { expected, actual },
    });
    this.expected = expected;
    this.actual = actual;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation", message, details ? { details } : {});
  }
}

export class InvalidParentError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("invalid_parent", message, details ? { details } : {});
  }
}

export class CycleError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("cycle", message, details ? { details } : {});
  }
}

export class StorageError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super("storage", message, options);
  }
}

export class NetworkError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super("network", message, options);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super("unauthorized", message);
  }
}

export class QuotaExceededError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("quota_exceeded", message, details ? { details } : {});
  }
}

export class ImportError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("import_invalid", message, details ? { details } : {});
  }
}

/**
 * The server cannot serve an incremental feed for this cursor because the
 * device was offline past the tombstone horizon. Not transient: it needs a full
 * resync, which the sync engine performs by clearing the checkpoint.
 */
export class StaleCheckpointError extends AppError {
  constructor(message = "This device has been offline too long; a full resync is required") {
    super("stale_checkpoint", message);
  }
}

/** True for errors the UI should retry automatically (transient). */
export function isRetryable(error: unknown): boolean {
  return error instanceof AppError && (error.code === "network" || error.code === "storage");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unexpected error";
}
