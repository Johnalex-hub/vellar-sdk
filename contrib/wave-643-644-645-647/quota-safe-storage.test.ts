import { describe, expect, it, vi } from "vitest";
import { createSessionStore, createWebStorageAdapter } from "../../src/session";
import type { WalletSession } from "../../src/types";
import { SessionPersistenceError, withQuotaTolerance } from "./quota-safe-storage";

const session: WalletSession = {
  accountId: "CWALLET",
  network: "testnet",
  connected: true,
  authMethod: "passkey",
  createdAt: "2026-10-19T00:00:00.000Z",
  lastActiveAt: "2026-10-19T00:00:00.000Z",
};

function fakeLocalStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
    removeItem: vi.fn((k: string) => void data.delete(k)),
  };
}

function quotaError(): DOMException {
  return new DOMException("The quota has been exceeded.", "QuotaExceededError");
}

describe("withQuotaTolerance", () => {
  it("happy path: persists normally and reports no degradation", async () => {
    const ls = fakeLocalStorage();
    const onError = vi.fn();
    const adapter = withQuotaTolerance(createWebStorageAdapter(ls), {
      onPersistenceError: onError,
    });
    const store = createSessionStore(adapter);

    await store.getState().start(session);

    expect(ls.data.get("vellar.session")).toBe(JSON.stringify(session));
    expect(onError).not.toHaveBeenCalled();
    expect(adapter.persistenceError).toBeNull();
  });

  it("QuotaExceededError on setItem surfaces a named SessionPersistenceError", async () => {
    const ls = fakeLocalStorage();
    ls.setItem.mockImplementation(() => {
      throw quotaError();
    });
    const onError = vi.fn();
    const adapter = withQuotaTolerance(createWebStorageAdapter(ls), {
      onPersistenceError: onError,
    });

    await expect(adapter.save(session)).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledOnce();
    const err = onError.mock.calls[0]![0] as SessionPersistenceError;
    expect(err).toBeInstanceOf(SessionPersistenceError);
    expect(err.name).toBe("SessionPersistenceError");
    expect(err.message).toMatch(/quota/i);
    expect(err.message).toMatch(/reload/i);
    expect((err.cause as DOMException).name).toBe("QuotaExceededError");
    expect(adapter.persistenceError).toBe(err);
  });

  it("in-memory session stays usable for the page lifetime when persistence fails", async () => {
    const ls = fakeLocalStorage();
    ls.setItem.mockImplementation(() => {
      throw quotaError();
    });
    const store = createSessionStore(withQuotaTolerance(createWebStorageAdapter(ls)));

    await expect(store.getState().start(session)).resolves.toBeUndefined();
    expect(store.getState().session).toEqual(session);
    expect(store.getState().status).toBe("connected");

    await store.getState().touch(new Date("2026-10-19T01:00:00.000Z"));
    expect(store.getState().session?.lastActiveAt).toBe("2026-10-19T01:00:00.000Z");
  });

  it("without the wrapper, a quota failure leaves start() rejected and the store disconnected", async () => {
    const ls = fakeLocalStorage();
    ls.setItem.mockImplementation(() => {
      throw quotaError();
    });
    const store = createSessionStore(createWebStorageAdapter(ls));

    await expect(store.getState().start(session)).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    expect(store.getState().session).toBeNull();
  });

  it("a session that failed to persist does not survive a reload", async () => {
    const ls = fakeLocalStorage();
    ls.setItem.mockImplementation(() => {
      throw quotaError();
    });
    await createSessionStore(withQuotaTolerance(createWebStorageAdapter(ls)))
      .getState()
      .start(session);

    const reloaded = createSessionStore(createWebStorageAdapter(ls));
    await reloaded.getState().restore();
    expect(reloaded.getState().status).toBe("disconnected");
    expect(reloaded.getState().session).toBeNull();
  });

  it("recovers: a later successful write clears the degraded flag", async () => {
    const ls = fakeLocalStorage();
    ls.setItem.mockImplementationOnce(() => {
      throw quotaError();
    });
    const adapter = withQuotaTolerance(createWebStorageAdapter(ls));

    await adapter.save(session);
    expect(adapter.persistenceError).not.toBeNull();
    await adapter.save(session);
    expect(adapter.persistenceError).toBeNull();
    expect(ls.data.has("vellar.session")).toBe(true);
  });

  it("recognises the legacy Firefox quota error name", async () => {
    const ls = fakeLocalStorage();
    ls.setItem.mockImplementation(() => {
      throw Object.assign(new Error("full"), { name: "NS_ERROR_DOM_QUOTA_REACHED" });
    });
    const adapter = withQuotaTolerance(createWebStorageAdapter(ls));
    await adapter.save(session);
    expect(adapter.persistenceError).toBeInstanceOf(SessionPersistenceError);
  });

  it("non-quota storage failures are not masked", async () => {
    const ls = fakeLocalStorage();
    ls.setItem.mockImplementation(() => {
      throw new Error("SecurityError: storage disabled");
    });
    const adapter = withQuotaTolerance(createWebStorageAdapter(ls));
    await expect(adapter.save(session)).rejects.toThrow("storage disabled");
    expect(adapter.persistenceError).toBeNull();
  });

  it("a throwing onPersistenceError callback cannot break the session", async () => {
    const ls = fakeLocalStorage();
    ls.setItem.mockImplementation(() => {
      throw quotaError();
    });
    const store = createSessionStore(
      withQuotaTolerance(createWebStorageAdapter(ls), {
        onPersistenceError: () => {
          throw new Error("listener bug");
        },
      }),
    );
    await expect(store.getState().start(session)).resolves.toBeUndefined();
    expect(store.getState().status).toBe("connected");
  });
});
