// Issue #647: `VellarWalletConfig.isValidAddress` is caller-supplied and typed
// `(address: string) => boolean`. Nothing stops an implementation from throwing
// (for example a raw `StrKey` decode error on malformed input) instead of
// returning false. Today that exception escapes `createPaymentClient` as the
// caller's own error with no hint that it came from the address validator.
//
// `guardAddressValidator` keeps the contract "false means invalid" and turns a
// throw into an `AddressValidatorError` that names the validator and the
// offending input and keeps the original error as `cause`. `wallet.pay()` then
// rejects before anything is built or signed.

export class AddressValidatorError extends Error {
  override readonly cause: unknown;
  readonly address: string;
  constructor(address: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `The \`isValidAddress\` validator threw while checking "${address}": ${detail}. ` +
        "Validators must return false for invalid input, not throw.",
    );
    this.name = "AddressValidatorError";
    this.address = address;
    this.cause = cause;
  }
}

export function guardAddressValidator(
  isValidAddress: (address: string) => boolean,
): (address: string) => boolean {
  return (address) => {
    try {
      return isValidAddress(address);
    } catch (err) {
      if (err instanceof AddressValidatorError) throw err;
      throw new AddressValidatorError(address, err);
    }
  };
}
