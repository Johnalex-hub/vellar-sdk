import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyNotDeployableError } from "../../src/policy-facade";
import {
  createVellarWalletWithOptionalDeps,
  MissingWalletDependencyError,
  type OptionalDepsConfig,
} from "./optional-deps";

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { credentials: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const token = { contractId: "CTOKEN", symbol: "XLM", decimals: 7 };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function build(extra: Partial<OptionalDepsConfig> = {}) {
  const gateway = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/policies/templates")) return jsonResponse([{ id: "spending-limit" }]);
    if (u.endsWith("/policies/generate")) return jsonResponse({ policy: { id: "p1" } });
    if (u.endsWith("/p1/simulate")) return jsonResponse({ ok: true });
    return jsonResponse({});
  });
  const backend = {
    submitWalletCreation: vi.fn(),
    lookupContractId: vi.fn(),
    submitTransaction: vi.fn(),
  };
  const wallet = createVellarWalletWithOptionalDeps({
    network: "testnet",
    appName: "Test App",
    backend: backend as never,
    isValidAddress: () => true,
    apiUrl: "https://api.test",
    policyFetch: gateway as never,
    readOnlyAccount: { accountId: "CWALLET" },
    ...extra,
  });
  return { wallet, gateway, backend };
}

describe("createVellarWallet with kit and sac omitted, policies.apiUrl set", () => {
  it("constructs without throwing", () => {
    expect(() => build()).not.toThrow();
  });

  it("policies.listTemplates, generate and simulate succeed against the mocked gateway", async () => {
    const { wallet, gateway } = build();

    await expect(wallet.policies.listTemplates()).resolves.toEqual([{ id: "spending-limit" }]);
    await expect(
      wallet.policies.generate({ version: "1", type: "spending-limit", owners: ["GOWNER"] }),
    ).resolves.toEqual({ id: "p1" });
    await expect(wallet.policies.simulate("p1")).resolves.toEqual({ ok: true });

    const simulateCall = gateway.mock.calls.find(([u]) => String(u).endsWith("/p1/simulate"));
    expect(JSON.parse((simulateCall![1] as RequestInit).body as string)).toEqual({
      wallet: "CWALLET",
    });
  });

  it("connect() rejects naming the missing kit, not a generic undefined error", async () => {
    const { wallet } = build();
    const err = await wallet.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingWalletDependencyError);
    expect((err as MissingWalletDependencyError).dependency).toBe("kit");
    expect((err as Error).message).toMatch(/`kit`/);
    expect((err as Error).message).not.toMatch(/undefined/);
  });

  it("create() rejects naming the missing kit", async () => {
    const { wallet } = build();
    await expect(wallet.create({ username: "alice" })).rejects.toMatchObject({
      name: "MissingWalletDependencyError",
      dependency: "kit",
    });
  });

  it("pay() rejects naming the missing sac when only kit is supplied", async () => {
    const kit = { createWallet: vi.fn(), connectWallet: vi.fn(), sign: vi.fn(), wallet: undefined };
    const { wallet } = build({ kit: kit as never });
    const err = await wallet.pay({ to: "CDEST", amount: 1n, token }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingWalletDependencyError);
    expect((err as MissingWalletDependencyError).dependency).toBe("sac");
    expect((err as Error).message).toMatch(/`sac`/);
  });

  it("pay() rejects naming the missing kit when both are omitted", async () => {
    const { wallet } = build();
    const err = await wallet.pay({ to: "CDEST", amount: 1n, token }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MissingWalletDependencyError);
    expect((err as MissingWalletDependencyError).dependency).toBe("kit");
  });

  it("policies.deploy rejects with the distinct policyAttach-missing error", async () => {
    const { wallet, gateway } = build();
    const err = await wallet.policies.deploy("p1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyNotDeployableError);
    expect((err as Error).message).toMatch(/policyAttach/);
    expect(err).not.toBeInstanceOf(MissingWalletDependencyError);
    expect(gateway).not.toHaveBeenCalled();
  });

  it("without apiUrl, wallet.policies still fails loudly", () => {
    const { wallet } = build({ apiUrl: undefined });
    expect(() => wallet.policies).toThrow(/apiUrl/);
  });

  it("without an account, listTemplates works but simulate needs a wallet", async () => {
    const { wallet } = build({ readOnlyAccount: undefined });
    await expect(wallet.policies.listTemplates()).resolves.toBeDefined();
    expect(() => wallet.policies.simulate("p1")).toThrow(/readOnlyAccount/);
  });
});
