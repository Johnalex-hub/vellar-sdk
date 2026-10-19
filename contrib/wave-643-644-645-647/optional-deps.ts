import {
  createVellarWallet,
  WalletNotReadyError,
  type VellarWallet,
  type VellarWalletConfig,
} from "../../src/client";
import { createPolicyFacade, type PolicyFacade } from "../../src/policy-facade";

// Issue #643: `createVellarWallet` types `kit` and `sac` as required, but the
// README implies policy read operations should work without them. Omitted at
// runtime they produce generic failures (`kit.connectWallet is not a function`,
// `Cannot read properties of undefined`). This wrapper accepts them as optional
// and fails each operation that needs them with a specific error naming the
// missing piece.
//
// What works without kit/sac (with `apiUrl`): policies.listTemplates and
// policies.generate. policies.simulate also needs a wallet address; with no kit
// there is never a session, so pass `readOnlyAccount`. policies.deploy fails
// with the existing PolicyNotDeployableError (policyAttach missing).

export class MissingWalletDependencyError extends WalletNotReadyError {
  readonly dependency: "kit" | "sac";
  constructor(dependency: "kit" | "sac", operation: string) {
    super(
      `${operation} requires \`${dependency}\` in createVellarWallet config, but it was omitted. ` +
        (dependency === "kit"
          ? "Pass a PasskeyKit instance as `kit`."
          : "Pass a SACClient as `sac`."),
    );
    this.name = "MissingWalletDependencyError";
    this.dependency = dependency;
  }
}

export type OptionalDepsConfig = Omit<VellarWalletConfig, "kit" | "sac"> & {
  kit?: VellarWalletConfig["kit"];
  sac?: VellarWalletConfig["sac"];
  /** Wallet to run policy simulate against when no session exists (no kit). */
  readOnlyAccount?: { accountId: string; keyId?: string };
  /** Injected fetch for the policy gateway (tests). */
  policyFetch?: typeof fetch;
};

export function createVellarWalletWithOptionalDeps(config: OptionalDepsConfig): VellarWallet {
  const { readOnlyAccount, policyFetch, ...rest } = config;

  const missingKit = (operation: string) => (): never => {
    throw new MissingWalletDependencyError("kit", operation);
  };
  const kit =
    config.kit ??
    ({
      createWallet: missingKit("create()"),
      connectWallet: missingKit("connect()"),
      sign: missingKit("pay()"),
      wallet: undefined,
    } satisfies VellarWalletConfig["kit"]);
  const sac =
    config.sac ??
    ({
      getSACClient: () => {
        throw new MissingWalletDependencyError("sac", "pay()");
      },
    } satisfies VellarWalletConfig["sac"]);

  const inner = createVellarWallet({ ...rest, kit, sac });

  const policies: PolicyFacade | null = config.apiUrl
    ? createPolicyFacade({
        apiUrl: config.apiUrl,
        network: config.network,
        fetch: policyFetch,
        attach: config.policyAttach,
        requireSession: () => {
          const session = inner.session ?? readOnlyAccount;
          if (!session) {
            throw new WalletNotReadyError(
              "Call create() or connect() (or pass readOnlyAccount) before using policies",
            );
          }
          return { accountId: session.accountId, keyId: session.keyId };
        },
      })
    : null;

  return {
    get session() {
      return inner.session;
    },
    get agents() {
      return inner.agents;
    },
    get x402() {
      return inner.x402;
    },
    get connector() {
      return inner.connector;
    },
    get payments() {
      return inner.payments;
    },
    get policies() {
      return policies ?? inner.policies;
    },
    create: (input) => inner.create(input),
    connect: () => inner.connect(),
    async pay(input) {
      if (!config.kit) throw new MissingWalletDependencyError("kit", "pay()");
      if (!config.sac) throw new MissingWalletDependencyError("sac", "pay()");
      return inner.pay(input);
    },
  };
}
