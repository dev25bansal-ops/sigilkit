/**
 * Error taxonomy wiring gate (API-ERR-1, completed 2026-09-26).
 *
 * The bug this pins: `errors.ts` shipped a `SigilKitErrorCode` union plus a set of
 * documented subclasses while the corresponding throw sites in `client.ts` still raised
 * a plain `Error` with the same message. The documentation described the *intended*
 * end state, so a caller who followed it wrote
 *
 *   if (err.code === "AUDIT_MISSING") { … }   // never true — fell through to default:
 *
 * and the branch was silently dead. `AUDIT_MISSING` is the worst case of the lot: it is
 * the error that fires when a successful transaction produced no `ActionLogged` event,
 * which is precisely the INV-3 audit violation the product exists to prevent — so the
 * one branch an operator most needs is the one that could never run.
 *
 * Two things are pinned here, and the second is the one that keeps this file from going
 * stale:
 *
 *  1. **Every code is reachable.** Each assertion drives a real throw site and checks
 *     both `instanceof` and `.code`. A class that is declared but not thrown fails here
 *     instead of quietly becoming an unreachable branch for consumers.
 *  2. **No code is missing from the union.** The declared `SigilKitErrorCode` strings are
 *     scraped from `src/errors.ts` and compared against a hand-listed set. Adding a
 *     class without a test, or renaming a code, fails — which is the only way to stop the
 *     documentation and the thrown surface from drifting apart again.
 *
 * Message text is also asserted, because the rewiring was required to be
 * message-preserving: existing consumers and the pre-existing regex assertions in
 * `execute.test.ts` / `nonce.test.ts` match on wording, not on type.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  encodeAbiParameters,
  pad,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  ACTION_LOGGED_TOPIC,
  InMemoryLeaseStore,
  NonceGate,
  SigilKitClient,
  ValidationError,
  AuditAmbiguousError,
  AuditMissingError,
  ExecutionRevertedError,
  GuardMissingError,
  LeaseBusyError,
  LeaseInvalidError,
  LeaseLostError,
  PolicyRejectedError,
  ReceiptTimeoutError,
  SigilKitError,
  SimulationRevertedError,
  type ExecutionGuard,
  type LeaseStore,
  type LeaseToken,
  type Scope,
} from "../src/index.js";
// `assertAddress` is not re-exported from the package root (it is an internal validation
// helper), so it is imported from its module directly — same as the SDK's own tests do.
import { assertAddress } from "../src/validation.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const MANAGER = "0x00000000000000000000000000000000000000aa" as Address;
const TARGET = "0x0000000000000000000000000000000000009001" as Address;
const KEY = "0x00000000000000000000000000000000000000bb" as Address;
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;

const SCOPE: Scope = {
  expiresAt: 4_102_444_800,
  windowSeconds: 600,
  perActionCap: 10n ** 18n,
  perWindowCap: 5n * 10n ** 18n,
  merkleRoot: `0x${"0".repeat(64)}` as Hex,
  countersignAbove: 0n,
  enforceNativeDelta: false,
  tokenWatchlist: [],
};

function prepareArgs(overrides: { value?: bigint } = {}) {
  return {
    account: privateKeyToAccount(AGENT_KEY),
    request: {
      agentId: `0x${"11".repeat(32)}` as Hex,
      target: TARGET,
      selector: "0x32145f90" as Hex,
      value: overrides.value ?? 0n,
      expiry: Math.floor(Date.now() / 1000) + 600,
      rationaleHash: `0x${"22".repeat(32)}` as Hex,
      data: "0x" as Hex,
    },
    scope: SCOPE,
  };
}

function auditLog(request: ReturnType<typeof prepareArgs>["request"]): Log {
  return {
    address: MANAGER,
    topics: [
      ACTION_LOGGED_TOPIC,
      request.agentId,
      pad(request.target),
      pad(request.selector, { dir: "right" }),
    ],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes32" }, { type: "uint48" }],
      [request.value, request.rationaleHash, 100],
    ),
    blockHash: `0x${"01".repeat(32)}`,
    blockNumber: 1n,
    transactionHash: TX_HASH,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as Log;
}

function harness(
  opts: {
    simFails?: boolean;
    logs?: Log[];
    status?: "success" | "reverted";
    leaseStore?: LeaseStore;
    receiptThrows?: boolean;
  } = {},
) {
  const sent: unknown[] = [];
  const publicClient = {
    readContract: async (a: { functionName: string }) => {
      if (a.functionName === "getNonce") return 0n;
      // ABI-02: one `SpendPolicy.WindowState` struct, not two positional outputs.
      if (a.functionName === "getWindowState") return { windowStart: 0n, spentThisWindow: 0n };
      throw new Error(`unexpected read ${a.functionName}`);
    },
    call: async () => {
      if (opts.simFails) throw Object.assign(new Error("execution reverted"), { data: "0x" });
      return "0x";
    },
    waitForTransactionReceipt: async () => {
      if (opts.receiptThrows) throw new Error("transport down");
      return { status: opts.status ?? "success", logs: opts.logs ?? [] };
    },
  } as unknown as PublicClient;

  const wallet = {
    account: privateKeyToAccount(AGENT_KEY),
    sendTransaction: async (tx: unknown) => {
      sent.push(tx);
      return TX_HASH;
    },
  } as unknown as WalletClient;

  const client = new SigilKitClient({
    managerAddress: MANAGER,
    chain: foundry,
    publicClient,
    leaseStore: opts.leaseStore,
  });
  return { client, sent, wallet };
}

/** Asserts an error is the expected class, carries the expected code, and is a SigilKitError. */
function expectCode(err: unknown, ctor: Function, code: string, messagePart?: string): void {
  expect(err, `expected a ${ctor.name} to be thrown`).toBeInstanceOf(ctor as never);
  expect(err).toBeInstanceOf(SigilKitError);
  const e = err as SigilKitError;
  expect(e.code).toBe(code);
  expect(e.name).toBe(ctor.name);
  if (messagePart !== undefined) expect(e.message).toContain(messagePart);
  // Every taxonomy error must stay catchable as a plain Error — consumers that have not
  // migrated to the taxonomy yet rely on this.
  expect(err).toBeInstanceOf(Error);
}

describe("error taxonomy: every declared code is actually thrown", () => {
  it("POLICY_REJECTED fires when the local pre-flight rejects the request", async () => {
    const { client } = harness();
    // Value above perActionCap: rejected locally, before any signature or gas.
    await expect(client.prepareExecution(prepareArgs({ value: 10n ** 30n }))).rejects.toSatisfy(
      (e: unknown) => {
        expectCode(e, PolicyRejectedError, "POLICY_REJECTED", "SigilKit policy rejection (pre-signature)");
        expect((e as PolicyRejectedError).reason).toBeTruthy();
        return true;
      },
    );
  });

  it("SIMULATION_REVERTED fires when executeSimulated's eth_call reverts", async () => {
    const { client, wallet, sent } = harness({ simFails: true });
    await expect(
      client.executeSimulated(prepareArgs(), wallet),
    ).rejects.toSatisfy((e: unknown) => {
      expectCode(e, SimulationRevertedError, "SIMULATION_REVERTED", "simulation rejection (no gas spent)");
      return true;
    });
    expect(sent).toHaveLength(0); // still the "no gas spent" guarantee
  });

  it("EXECUTION_REVERTED fires from sendPrepared and from assertAuditEmitted", async () => {
    const reverted = harness({ status: "reverted" });
    const prepared = await reverted.client.prepareExecution(prepareArgs());
    await expect(reverted.client.sendPrepared(prepared, reverted.wallet)).rejects.toSatisfy(
      (e: unknown) => {
        expectCode(e, ExecutionRevertedError, "EXECUTION_REVERTED", "reverted; nothing was executed or audited");
        expect((e as ExecutionRevertedError).txHash).toBe(TX_HASH);
        return true;
      },
    );

    const other = harness({ status: "reverted" });
    await expect(other.client.assertAuditEmitted(TX_HASH as Hash)).rejects.toSatisfy(
      (e: unknown) => {
        expectCode(e, ExecutionRevertedError, "EXECUTION_REVERTED");
        expect((e as ExecutionRevertedError).txHash).toBe(TX_HASH);
        return true;
      },
    );
  });

  it("RECEIPT_TIMEOUT carries the txHash and timeout, and is NOT downgraded by revert decoration", async () => {
    // The `cause` here still holds revert data, which is exactly the case where
    // `decorateWithDecodedRevert` would previously replace the typed error with a plain
    // `Error`, silently dropping `.code` and `.txHash`.
    const { client, wallet } = harness({ receiptThrows: true });
    const prepared = await client.prepareExecution(prepareArgs());
    await expect(client.sendPrepared(prepared, wallet)).rejects.toSatisfy((e: unknown) => {
      expectCode(
        e,
        ReceiptTimeoutError,
        "RECEIPT_TIMEOUT",
        "do NOT resend, the nonce is likely already consumed",
      );
      const err = e as ReceiptTimeoutError;
      expect(err.txHash).toBe(TX_HASH);
      expect(err.timeoutMs).toBeGreaterThan(0);
      return true;
    });
  });

  it("AUDIT_MISSING fires when a successful tx has no ActionLogged — the INV-3 guard", async () => {
    const { client, wallet } = harness({ status: "success", logs: [] });
    const prepared = await client.prepareExecution(prepareArgs());
    await expect(client.sendPrepared(prepared, wallet)).rejects.toSatisfy((e: unknown) => {
      expectCode(e, AuditMissingError, "AUDIT_MISSING", "INV-3 violated");
      expect((e as AuditMissingError).txHash).toBe(TX_HASH);
      return true;
    });
  });

  it("AUDIT_AMBIGUOUS fires when two ActionLogged records match", async () => {
    const args = prepareArgs();
    const { client, wallet } = harness({
      status: "success",
      logs: [auditLog(args.request), { ...auditLog(args.request), logIndex: 1 }],
    });
    const prepared = await client.prepareExecution(args);
    await expect(client.sendPrepared(prepared, wallet)).rejects.toSatisfy((e: unknown) => {
      expectCode(e, AuditAmbiguousError, "AUDIT_AMBIGUOUS", "ambiguous ActionLogged audit evidence");
      return true;
    });
  });

  it("LEASE_LOST fires when a superseded holder's guard is used", async () => {
    const store = new InMemoryLeaseStore();
    // Superseding is modelled the way the rest of the suite does it: the store reports
    // the token is no longer current, which is exactly what another worker's acquire
    // would cause on a real shared store.
    vi.spyOn(store, "isCurrent").mockReturnValue(false);
    await expect(
      new NonceGate(store).run(KEY, async (guard) => {
        await guard.assertCurrent();
        return "unreachable";
      }),
    ).rejects.toSatisfy((e: unknown) => {
      expectCode(e, LeaseLostError, "LEASE_LOST", "was lost (superseded by another worker)");
      expect((e as LeaseLostError).key).toBe(KEY);
      return true;
    });
  });

  it("LEASE_BUSY fires when another worker holds the key", async () => {
    const store = new InMemoryLeaseStore();
    // A store that declines every acquisition is the observable form of "held elsewhere".
    vi.spyOn(store, "acquire").mockReturnValue(null);
    await expect(new NonceGate(store).run(KEY, async () => "unreachable")).rejects.toSatisfy(
      (e: unknown) => {
        expectCode(e, LeaseBusyError, "LEASE_BUSY", "is busy in another worker");
        expect((e as LeaseBusyError).key).toBe(KEY);
        return true;
      },
    );
  });

  it("LEASE_INVALID fires for a v1 lease store and for an unusable token", async () => {
    // A key-only (v1) store cannot prove ownership, so it is rejected outright.
    const v1 = {
      version: 1,
      acquire: async () => null,
      release: async () => undefined,
    } as unknown as LeaseStore;
    expect(() => new NonceGate(v1)).toThrow(LeaseInvalidError);
    try {
      new NonceGate(v1);
    } catch (e) {
      expectCode(e, LeaseInvalidError, "LEASE_INVALID", "must implement the v2 token API");
    }

    // A v2 store returning a token that cannot prove ownership.
    const badToken = {
      version: 2,
      acquire: async () => ({ key: KEY, id: "", epoch: 0 }) as unknown as LeaseToken,
      renew: async () => true,
      isCurrent: async () => true,
      release: async () => undefined,
    } as unknown as LeaseStore;
    await expect(
      new NonceGate(badToken).run(KEY, async () => "unreachable"),
    ).rejects.toSatisfy((e: unknown) => {
      expectCode(e, LeaseInvalidError, "LEASE_INVALID", "invalid v2 lease token");
      return true;
    });
  });

  it("GUARD_MISSING fires for every guard failure mode", async () => {
    // (a) a lease store is configured but no guard is passed at all.
    const { client, wallet } = harness({ leaseStore: new InMemoryLeaseStore() });
    const args = prepareArgs();
    await expect(client.execute(args, wallet)).rejects.toSatisfy((e: unknown) => {
      expectCode(e, GuardMissingError, "GUARD_MISSING", "a lease store is configured");
      return true;
    });

    // (b) a hand-rolled guard that this client's nonceGate never issued.
    const fake: ExecutionGuard = {
      key: args.account.address,
      signal: new AbortController().signal,
      assertCurrent: async () => undefined,
    };
    await expect(client.execute(args, wallet, fake)).rejects.toSatisfy((e: unknown) => {
      expectCode(e, GuardMissingError, "GUARD_MISSING", "must originate from this client's");
      return true;
    });

    // (c) a genuine guard from a *different* client's gate.
    await expect(
      new NonceGate(new InMemoryLeaseStore()).run(args.account.address, (guard) =>
        client.execute(args, wallet, guard),
      ),
    ).rejects.toSatisfy((e: unknown) => {
      expectCode(e, GuardMissingError, "GUARD_MISSING", "must originate from this client's");
      return true;
    });

    // (d) a real guard whose key is not the signing session key.
    await expect(
      client.nonceGate.run(TARGET, (guard) => client.execute(args, wallet, guard)),
    ).rejects.toSatisfy((e: unknown) => {
      expectCode(e, GuardMissingError, "GUARD_MISSING", "does not match the signing session key");
      return true;
    });
  });

  it("GUARD_MISSING fires when a guard outlives its run", async () => {
    const gate = new NonceGate(new InMemoryLeaseStore());
    let escaped: ExecutionGuard | undefined;
    await gate.run(KEY, async (guard) => {
      escaped = guard;
      await guard.assertCurrent(); // fine while the run is live
      return "ok";
    });
    expect(escaped).toBeDefined();
    // The run has returned, so the guard is spent. Using it is the "escaped the callback"
    // mistake that would otherwise broadcast outside the lease.
    await expect(escaped!.assertCurrent()).rejects.toSatisfy((e: unknown) => {
      expectCode(e, GuardMissingError, "GUARD_MISSING", "used after its run finished");
      return true;
    });
  });

  it("VALIDATION is thrown by the assert* helpers and carries the field name", () => {
    try {
      assertAddress("not-an-address", "managerAddress");
      throw new Error("assertAddress should have thrown");
    } catch (e) {
      expectCode(e, ValidationError, "VALIDATION", "managerAddress");
      expect((e as ValidationError).field).toBe("managerAddress");
    }
  });
});

describe("error taxonomy: the union and the classes cannot drift apart", () => {
  const source = readFileSync(join(HERE, "..", "src", "errors.ts"), "utf8");

  it("declares exactly the codes the tests above drive — no unreachable branch is left in the union", () => {
    // Scraped from the union literal in src/errors.ts rather than imported, so this test
    // checks the *declared* surface, not TypeScript's view of it. The slice runs to the
    // closing `;` — a non-greedy match to the first `;` would stop inside the per-member
    // doc comments, which is a silent under-count rather than a failure.
    const union = /export type SigilKitErrorCode =([\s\S]*?);\s*\n/.exec(source);
    expect(union, "could not locate the SigilKitErrorCode union in src/errors.ts").toBeTruthy();
    const declared = [...(union![1]!.matchAll(/"([A-Z_]+)"/g))].map((m) => m[1]!).sort();

    // Every code reachable from a throw site, per the assertions above.
    const reachable = [
      "AUDIT_AMBIGUOUS",
      "AUDIT_MISSING",
      "EXECUTION_REVERTED",
      "GUARD_MISSING",
      "LEASE_BUSY",
      "LEASE_INVALID",
      "LEASE_LOST",
      "POLICY_REJECTED",
      "RECEIPT_TIMEOUT",
      "SIMULATION_REVERTED",
      "VALIDATION",
    ].sort();

    expect(
      declared,
      "SigilKitErrorCode and the throw sites disagree — a code with no throw site is a " +
        "branch callers can write but never enter; a thrown code missing from the union " +
        "cannot be narrowed at all",
    ).toEqual(reachable);
  });

  it("every declared class sets a name matching its own class", () => {
    for (const name of [
      "PolicyRejectedError",
      "SimulationRevertedError",
      "ExecutionRevertedError",
      "ReceiptTimeoutError",
      "AuditMissingError",
      "AuditAmbiguousError",
      "LeaseBusyError",
      "LeaseInvalidError",
      "GuardMissingError",
      "ValidationError",
    ]) {
      expect(source, `${name} is not declared in src/errors.ts or src/validation.ts`).toBeTruthy();
    }
    // Each class must assign `this.name`, otherwise `err.name` is the bare "Error" and
    // log-based triage loses the distinction the `code` was added to provide.
    const assignments = [...source.matchAll(/this\.name = "([A-Za-z]+)"/g)].map((m) => m[1]!);
    for (const name of [
      "PolicyRejectedError",
      "SimulationRevertedError",
      "ExecutionRevertedError",
      "ReceiptTimeoutError",
      "AuditMissingError",
      "AuditAmbiguousError",
      "LeaseBusyError",
      "LeaseInvalidError",
      "GuardMissingError",
    ]) {
      expect(assignments, `${name} never sets this.name`).toContain(name);
    }
  });

  it("no taxonomy error is documented as 'declared but not yet thrown' any more", () => {
    // The wording that caused the original divergence: the docs described the target
    // state while the code had not reached it. If a future migration regresses, the note
    // has to come back — and this assertion is what forces the author to be explicit
    // about it rather than quietly optimistic.
    expect(
      source.includes("Declared but not yet thrown") ||
        source.includes("not yet wired in"),
      "src/errors.ts re-introduces a 'declared but not thrown' note. If a code is genuinely " +
        "unwired, say so AND keep its throw site unwired — do not document the target state.",
    ).toBe(false);
  });
});
