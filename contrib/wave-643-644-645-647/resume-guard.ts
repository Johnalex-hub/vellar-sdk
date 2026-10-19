import type { PasskeyKitLike } from "../../src/passkeykit-connector";
import { resumeKitConnection } from "../../src/passkeykit-connector";
import type { SessionStore } from "../../src/session";
import type { WalletSession } from "../../src/types";

// Issue #644: a passkey-kit resume (`resumeKitConnection` -> kit.connectWallet)
// can still be pending when the caller navigates away, unmounts, or explicitly
// disconnects. A late resolution must not start a session on a store the caller
// has already torn down, and a late rejection must not surface as an unhandled
// rejection.
//
// The guard is a generation counter plus a disposed latch. Every resume claims a
// new generation; it is "current" only while the guard is live and no newer
// resume has been claimed. Anything else is "stale": its result is dropped.
//
// Lifecycle contract for callers wrapping the connector in a component framework
// (React/Vue/Svelte/...):
//   1. Create ONE guard per mounted owner (component, provider, extension page).
//   2. Call `resumeAndStartSession` from the mount effect; never `await` it in
//      a way that blocks render.
//   3. Call `guard.dispose()` from the unmount/teardown path, and before or
//      together with `store.getState().end()` / `store.getState().dispose()`.
//   4. After `dispose()` every in-flight resume settles as "stale": no store
//      mutation, no storage write, no rejection. The underlying WebAuthn
//      ceremony itself cannot be cancelled by the SDK; only its effects are.
//   5. A resume rejecting while the guard is still live rejects to the caller
//      as normal (for example the key is no longer a signer): handle it.

export type ResumeOutcome = "applied" | "stale";

export interface ResumeGuard {
  /** Claim a new generation; returns a predicate that is true only while it is current. */
  begin(): () => boolean;
  /** Mark the owner torn down. Idempotent. All in-flight and future resumes become stale. */
  dispose(): void;
  readonly disposed: boolean;
}

export function createResumeGuard(): ResumeGuard {
  let generation = 0;
  let disposed = false;
  return {
    begin() {
      const mine = ++generation;
      return () => !disposed && mine === generation;
    },
    dispose() {
      disposed = true;
    },
    get disposed() {
      return disposed;
    },
  };
}

export interface ResumeAndStartSessionInput {
  guard: ResumeGuard;
  kit: Pick<PasskeyKitLike, "connectWallet" | "wallet">;
  /** The session to start once the kit connection is re-attached. Must carry `keyId`. */
  session: WalletSession;
  store: SessionStore;
}

/**
 * Resume the kit connection for `session.keyId`, then start the session on the
 * store, but only if the guard is still current when the resume settles.
 */
export async function resumeAndStartSession({
  guard,
  kit,
  session,
  store,
}: ResumeAndStartSessionInput): Promise<ResumeOutcome> {
  const isCurrent = guard.begin();
  if (!isCurrent()) return "stale";
  if (!session.keyId) {
    throw new TypeError("resumeAndStartSession requires session.keyId");
  }

  try {
    await resumeKitConnection(kit, session.keyId);
  } catch (err) {
    if (!isCurrent()) return "stale";
    throw err;
  }
  if (!isCurrent()) return "stale";

  await store.getState().start(session);
  // start() awaits storage; if teardown raced it, undo rather than leave a
  // connected store behind a disposed owner.
  if (!isCurrent()) {
    await store.getState().end();
    return "stale";
  }
  return "applied";
}
