import { AppError, NetworkError, UnauthorizedError } from "@localnotes/shared";

export function isOfflineError(error: unknown): boolean {
  return error instanceof NetworkError || (error instanceof AppError && error.code === "network");
}

export function isAuthError(error: unknown): boolean {
  return error instanceof UnauthorizedError;
}

/**
 * Exponential backoff with jitter, capped at five minutes. A manual "Sync now"
 * bypasses it by resetting the queue's `nextAttemptAt`.
 */
export function nextAttemptDelay(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempts - 1), 5 * 60 * 1000);
  return Math.round(base * (0.5 + random() * 0.5));
}
