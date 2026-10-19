import type { SessionStorageAdapter } from "../../src/session";
import type { WalletSession } from "../../src/types";

// Issue #645: `createWebStorageAdapter` calls `storage.setItem` directly, and
// `createSessionStore.start()` awaits `storage.save()` BEFORE it sets in-memory
// state. So when the browser throws QuotaExceededError (Safari private mode, a
// nearly full quota) `start()` rejects with a raw DOMException and the store
// never becomes "connected": the user cannot use a wallet they just created.
//
// This wrapper makes persistence best-effort for quota failures only: the error
// is converted to a named `SessionPersistenceError`, reported through
// `onPersistenceError` and `persistenceError`, and `save()` resolves so the store
// keeps the session in memory for the current page lifetime.
//
// Degraded-persistence behavior (what a consumer should expect):
//   - The session works normally until the page is closed or reloaded.
//   - After a reload `restore()` finds nothing and the user is disconnected, so
//     they must reconnect with their passkey.
//   - The next successful `save()` (for example a later `touch()` once quota
//     frees up) clears `persistenceError`.
//   - Non-quota storage failures (storage disabled, SecurityError) are NOT
//     swallowed; they still reject as before.

export class SessionPersistenceError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(
      "Could not persist the wallet session: browser storage quota exceeded. " +
        "The session stays usable for this page, but will not survive a reload; " +
        "the user will need to reconnect with their passkey.",
    );
    this.name = "SessionPersistenceError";
    this.cause = cause;
  }
}

const QUOTA_ERROR_NAMES = new Set(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"]);

export function isQuotaExceededError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return (
    (typeof e.name === "string" && QUOTA_ERROR_NAMES.has(e.name)) ||
    e.code === 22 ||
    e.code === 1014
  );
}

export interface QuotaTolerantStorageAdapter extends SessionStorageAdapter {
  /** The last quota failure, or null if persistence is healthy. */
  readonly persistenceError: SessionPersistenceError | null;
}

export interface QuotaToleranceOptions {
  /** Called on every quota failure. Exceptions thrown here are ignored. */
  onPersistenceError?: (error: SessionPersistenceError) => void;
}

export function withQuotaTolerance(
  inner: SessionStorageAdapter,
  options: QuotaToleranceOptions = {},
): QuotaTolerantStorageAdapter {
  let persistenceError: SessionPersistenceError | null = null;
  return {
    get persistenceError() {
      return persistenceError;
    },
    load: () => inner.load(),
    clear: () => inner.clear(),
    async save(session: WalletSession) {
      try {
        await inner.save(session);
        persistenceError = null;
      } catch (err) {
        if (!isQuotaExceededError(err)) throw err;
        persistenceError = new SessionPersistenceError(err);
        try {
          options.onPersistenceError?.(persistenceError);
        } catch {
          // A faulty listener must not take the session down with it.
        }
      }
    },
  };
}
