# Wave 643-644-645-647: Lifecycle and Failure-Mode Hardening

Scoped to `contrib/` per CONTRIBUTING.md rule 3. Each section documents the
small change needed outside `contrib/` to wire it in. All tests run against the
real, unmodified `src/` modules.

Run: `npx vitest run contrib/wave-643-644-645-647`

---

## 1. Late passkey-kit resume after teardown (#644)

`resume-guard.ts` wraps `resumeKitConnection` (src/passkeykit-connector.ts) with a
staleness guard.

### What it does
- `createResumeGuard()` returns a guard with `begin()` and idempotent `dispose()`.
- `resumeAndStartSession({ guard, kit, session, store })` resumes the kit, then
  calls `store.start(session)` only if the guard is still current. It returns
  `"applied"` or `"stale"`.
- A resume that resolves after `dispose()` (or after a newer resume began) never
  touches the store or storage.
- A resume that rejects after `dispose()` is swallowed, so no unhandled rejection.
  A rejection while still live propagates to the caller.

### Lifecycle contract for callers wrapping the connector in a component framework
1. Create one guard per mounted owner (component, provider, extension page).
2. Start the resume from the mount effect; do not block render on it.
3. Call `guard.dispose()` on unmount/teardown, before or together with
   `store.getState().end()` / `store.getState().dispose()`.
4. After `dispose()` every in-flight resume settles as `"stale"`. The WebAuthn
   ceremony itself cannot be cancelled by the SDK; only its effects are dropped.
5. A live resume failure (for example the key is no longer a signer) rejects to
   the caller: handle it.

### Integration into Core
1. Move `createResumeGuard` / `resumeAndStartSession` next to `resumeKitConnection`
   in `src/passkeykit-connector.ts` and export them from `src/index.ts`.
2. Add the lifecycle contract above to the doc comment on `resumeKitConnection`.

---

## 2. kit and sac omitted, policies apiUrl set (#643)

`optional-deps.ts` exports `createVellarWalletWithOptionalDeps`.

### What it does
- `kit` and `sac` are optional. Omitted, `create()` and `connect()` reject with
  `MissingWalletDependencyError` (`dependency: "kit"`), and `pay()` rejects naming
  `kit` or `sac`, instead of `kit.connectWallet is not a function`.
- `MissingWalletDependencyError` extends `WalletNotReadyError`, so existing
  `instanceof` handling keeps working.
- `policies.listTemplates` and `policies.generate` work with only `apiUrl`.
  `policies.simulate` needs a wallet address; with no kit there is never a
  session, so pass `readOnlyAccount: { accountId }`.
- `policies.deploy` rejects with the existing `PolicyNotDeployableError`
  (policyAttach missing) before any network call.

### Integration into Core
1. In `src/client.ts` make `kit?` and `sac?` optional in `VellarWalletConfig`.
2. Add `MissingWalletDependencyError`; substitute throwing stand-ins for a missing
   `kit` / `sac`, and check both at the top of `pay()` before the session check.
3. In `src/policy-facade.ts` `deploy()`, check `deps.attach` before
   `requireSession()` so the policyAttach error is not masked by a missing session.

---

## 3. localStorage QuotaExceededError during session persistence (#645)

`quota-safe-storage.ts` exports `withQuotaTolerance(adapter, { onPersistenceError })`.

### Why it is needed
`createSessionStore.start()` awaits `storage.save()` before setting in-memory
state, so today a quota failure makes `start()` reject with a raw `DOMException`
and the store never becomes connected.

### Degraded-persistence behavior (document this for consumers)
- A quota failure becomes a named `SessionPersistenceError` (original error in
  `cause`), delivered to `onPersistenceError` and exposed as `persistenceError`.
- The session stays usable in memory for the current page lifetime.
- It will NOT survive a reload: `restore()` reports disconnected and the user
  reconnects with their passkey.
- The next successful `save()` clears `persistenceError`.
- Non-quota failures (storage disabled, `SecurityError`) still reject.

### Integration into Core
1. Fold the quota handling into `createWebStorageAdapter` in `src/session.ts`
   (or export `withQuotaTolerance` and use it by default).
2. Add the degraded-persistence note above to the doc comment on
   `SessionStorageAdapter` / `createWebStorageAdapter`.

---

## 4. isValidAddress that throws (#647)

`address-validator.ts` exports `guardAddressValidator` and `AddressValidatorError`.

### What it does
- A validator that returns normally is passed through unchanged.
- A validator that throws becomes `AddressValidatorError`, naming
  `isValidAddress`, the offending address, and the original message, with the
  original error as `cause`.
- `wallet.pay()` rejects before the SAC client is called or anything is signed.
  Tests also pin the unguarded behavior (the raw error still rejects before signing).

### Integration into Core
1. Wrap `config.isValidAddress` with `guardAddressValidator` in `createVellarWallet`
   (`src/client.ts`) and export `AddressValidatorError`.
2. Document the contract on `isValidAddress` in `VellarWalletConfig`
   (src/client.ts) and, for the type comment requested in the issue, in
   `src/types.ts`:

```ts
/**
 * Validates a Stellar address (for example StrKey.isValidEd25519PublicKey or
 * StrKey.isValidContract). Contract: return true for a valid address and false
 * for an invalid one. Implementations MUST NOT throw: a throw is surfaced as an
 * AddressValidatorError and aborts the payment before anything is signed.
 */
export type AddressValidator = (address: string) => boolean;
```
