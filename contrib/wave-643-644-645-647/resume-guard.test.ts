import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryStorageAdapter,
  createSessionStore,
} from "../../src/session";
import type { WalletSession } from "../../src/types";
import { createResumeGuard, resumeAndStartSession } from "./resume-guard";

const session: WalletSession = {
  accountId: "CWALLET",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-10-19T00:00:00.000Z",
  lastActiveAt: "2026-10-19T00:00:00.000Z",
  keyId: "key-123",
};

type Connected = { keyIdBase64: string; contractId: string };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));
afterEach(() => {
  unhandled.length = 0;
});

describe("resumeAndStartSession", () => {
  it("happy path: resumes the kit and starts the session", async () => {
    const connectWallet = vi.fn(async () => ({ keyIdBase64: "key-123", contractId: "CWALLET" }));
    const store = createSessionStore(createMemoryStorageAdapter());

    const outcome = await resumeAndStartSession({
      guard: createResumeGuard(),
      kit: { connectWallet, wallet: undefined },
      session,
      store,
    });

    expect(outcome).toBe("applied");
    expect(connectWallet).toHaveBeenCalledWith({ keyId: "key-123" });
    expect(store.getState().session).toEqual(session);
    expect(store.getState().status).toBe("connected");
  });

  it("a resume resolving after the connector was disconnected does not start a session", async () => {
    const gate = deferred<Connected>();
    const adapter = createMemoryStorageAdapter();
    const save = vi.spyOn(adapter, "save");
    const store = createSessionStore(adapter);
    const guard = createResumeGuard();

    const pending = resumeAndStartSession({
      guard,
      kit: { connectWallet: () => gate.promise, wallet: undefined },
      session,
      store,
    });

    await store.getState().end();
    guard.dispose();
    gate.resolve({ keyIdBase64: "key-123", contractId: "CWALLET" });

    await expect(pending).resolves.toBe("stale");
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().session).toBeNull();
    expect(store.getState().status).toBe("disconnected");
  });

  it("a resume resolving after the store was disposed does not touch storage", async () => {
    const gate = deferred<Connected>();
    const adapter = createMemoryStorageAdapter();
    const save = vi.spyOn(adapter, "save");
    const store = createSessionStore(adapter);
    const guard = createResumeGuard();

    const pending = resumeAndStartSession({
      guard,
      kit: { connectWallet: () => gate.promise, wallet: undefined },
      session,
      store,
    });

    store.getState().dispose();
    guard.dispose();
    gate.resolve({ keyIdBase64: "key-123", contractId: "CWALLET" });

    await expect(pending).resolves.toBe("stale");
    expect(save).not.toHaveBeenCalled();
  });

  it("a resume rejecting after dispose() is swallowed, not an unhandled rejection", async () => {
    const gate = deferred<Connected>();
    const store = createSessionStore(createMemoryStorageAdapter());
    const guard = createResumeGuard();

    const pending = resumeAndStartSession({
      guard,
      kit: { connectWallet: () => gate.promise, wallet: undefined },
      session,
      store,
    });

    guard.dispose();
    gate.reject(new Error("WebAuthn aborted by navigation"));

    await expect(pending).resolves.toBe("stale");
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  });

  it("a resume rejecting while still live propagates to the caller", async () => {
    const store = createSessionStore(createMemoryStorageAdapter());

    await expect(
      resumeAndStartSession({
        guard: createResumeGuard(),
        kit: {
          connectWallet: async () => {
            throw new Error("key no longer a signer");
          },
          wallet: undefined,
        },
        session,
        store,
      }),
    ).rejects.toThrow("key no longer a signer");
    expect(store.getState().session).toBeNull();
  });

  it("a resume overlapped by a newer one is stale even without dispose()", async () => {
    const first = deferred<Connected>();
    const store = createSessionStore(createMemoryStorageAdapter());
    const guard = createResumeGuard();

    const older = resumeAndStartSession({
      guard,
      kit: { connectWallet: () => first.promise, wallet: undefined },
      session,
      store,
    });
    const newer = await resumeAndStartSession({
      guard,
      kit: {
        connectWallet: async () => ({ keyIdBase64: "key-2", contractId: "CWALLET" }),
        wallet: undefined,
      },
      session: { ...session, keyId: "key-2" },
      store,
    });
    first.resolve({ keyIdBase64: "key-123", contractId: "CWALLET" });

    expect(newer).toBe("applied");
    await expect(older).resolves.toBe("stale");
    expect(store.getState().session?.keyId).toBe("key-2");
  });

  it("dispose() is idempotent and a disposed guard refuses new work as stale", async () => {
    const connectWallet = vi.fn();
    const store = createSessionStore(createMemoryStorageAdapter());
    const guard = createResumeGuard();
    guard.dispose();
    guard.dispose();

    const outcome = await resumeAndStartSession({
      guard,
      kit: { connectWallet, wallet: undefined },
      session,
      store,
    });
    expect(outcome).toBe("stale");
    expect(connectWallet).not.toHaveBeenCalled();
  });
});
