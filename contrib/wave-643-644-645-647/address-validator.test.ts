import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVellarWallet } from "../../src/client";
import type { TokenInfo } from "../../src/balances";
import { AddressValidatorError, guardAddressValidator } from "./address-validator";

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { credentials: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const token: TokenInfo = { contractId: "CTOKEN", symbol: "XLM", decimals: 7 };

function build(isValidAddress: (a: string) => boolean) {
  const transfer = vi.fn(async () => "built-transfer-xdr");
  const kit = {
    createWallet: vi.fn(),
    connectWallet: vi.fn(async () => ({ keyIdBase64: "key123", contractId: "CWALLET" })),
    sign: vi.fn(async (tx: unknown) => tx),
    wallet: undefined,
  };
  const backend = {
    submitWalletCreation: vi.fn(),
    lookupContractId: vi.fn(async () => ({ contractId: "CWALLET", sessionId: "s" })),
    submitTransaction: vi.fn(async () => ({ hash: "txhash" })),
  };
  const sac = { getSACClient: vi.fn(() => ({ transfer })) };
  const wallet = createVellarWallet({
    network: "testnet",
    appName: "Test App",
    kit: kit as never,
    backend: backend as never,
    sac: sac as never,
    isValidAddress,
  });
  return { wallet, kit, backend, sac };
}

const throwingValidator = (address: string): boolean => {
  if (address === "explode") throw new TypeError("strkey decode blew up");
  return address.startsWith("G") || address.startsWith("C");
};

describe("guardAddressValidator", () => {
  it("passes through true/false results unchanged", () => {
    const guarded = guardAddressValidator(throwingValidator);
    expect(guarded("GABC")).toBe(true);
    expect(guarded("nope")).toBe(false);
  });

  it("converts a throwing validator into an attributable AddressValidatorError", () => {
    const guarded = guardAddressValidator(throwingValidator);
    let caught: unknown;
    try {
      guarded("explode");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AddressValidatorError);
    const err = caught as AddressValidatorError;
    expect(err.name).toBe("AddressValidatorError");
    expect(err.message).toContain("isValidAddress");
    expect(err.message).toContain("strkey decode blew up");
    expect(err.address).toBe("explode");
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it("handles a validator that throws a non-Error value", () => {
    const guarded = guardAddressValidator(() => {
      throw "boom";
    });
    expect(() => guarded("x")).toThrow(AddressValidatorError);
    expect(() => guarded("x")).toThrow(/boom/);
  });

  it("does not double-wrap when guarded twice", () => {
    const guarded = guardAddressValidator(guardAddressValidator(throwingValidator));
    let caught: unknown;
    try {
      guarded("explode");
    } catch (e) {
      caught = e;
    }
    expect((caught as AddressValidatorError).cause).toBeInstanceOf(TypeError);
  });
});

describe("wallet.pay with a validator that throws", () => {
  it("rejects with AddressValidatorError and never builds or signs", async () => {
    const { wallet, kit, sac, backend } = build(guardAddressValidator(throwingValidator));
    await wallet.connect();

    await expect(wallet.pay({ to: "explode", amount: 5n, token })).rejects.toBeInstanceOf(
      AddressValidatorError,
    );
    expect(sac.getSACClient).not.toHaveBeenCalled();
    expect(kit.sign).not.toHaveBeenCalled();
    expect(backend.submitTransaction).not.toHaveBeenCalled();
  });

  it("an unguarded throwing validator still rejects pay() before signing", async () => {
    const { wallet, kit, sac } = build(throwingValidator);
    await wallet.connect();

    await expect(wallet.pay({ to: "explode", amount: 5n, token })).rejects.toThrow(
      "strkey decode blew up",
    );
    expect(sac.getSACClient).not.toHaveBeenCalled();
    expect(kit.sign).not.toHaveBeenCalled();
  });

  it("a guarded validator does not disturb a valid payment", async () => {
    const { wallet, backend } = build(guardAddressValidator(throwingValidator));
    await wallet.connect();

    await expect(wallet.pay({ to: "CDEST", amount: 5n, token })).resolves.toEqual({
      hash: "txhash",
    });
    expect(backend.submitTransaction).toHaveBeenCalledOnce();
  });

  it("a guarded validator returning false rejects as InvalidRecipientError", async () => {
    const { wallet } = build(guardAddressValidator(throwingValidator));
    await wallet.connect();

    const err = await wallet.pay({ to: "nope", amount: 5n, token }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AddressValidatorError);
    expect((err as Error).name).toBe("InvalidRecipientError");
  });
});
