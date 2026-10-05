#!/usr/bin/env node
/**
 * proof-demo — the SigilKit claim, demonstrated end to end on a live chain.
 *
 * This exists for review and teaching: it deploys nothing and trusts nothing the demo
 * printed. It reads the deployed manager back off the chain, reconstructs the agent's grant,
 * and then makes the agent attempt four actions it is NOT allowed to make — each signed with
 * a genuine EIP-712 signature from the agent key, so each attempt passes signature recovery
 * and is refused by the POLICY check rather than dying early on a bad signature. Every
 * attempt is an `eth_call`, so nothing is broadcast and the chain state is untouched.
 *
 * Then it reads the audit trail back and prints it. The point of the exercise is that a
 * reviewer can check these claims independently rather than take the demo's word for it.
 *
 * PREREQUISITES
 *   1. anvil listening (any chain id works; the demo's own README says 31337)
 *   2. a DEPLOYED SessionKeyManager, and a session key granted to a key you control
 *   3. `forge inspect SessionKeyManager abi --json` — or point SIGILKIT_MANAGER_ABI at a
 *      saved copy
 *
 * USAGE
 *   node scripts/proof-demo.mjs --manager <address> --counter <address> \
 *        --agent-key <hex> [--rpc http://127.0.0.1:8545] [--chain-id 31337]
 *
 *   `--agent-key` defaults to Anvil dev account #1, which is what `npm run demo -- --grant`
 *   grants to. That key is PUBLIC and must never hold real funds.
 *
 * WHY EXPIRY USES THE CHAIN CLOCK. A fresh `anvil` starts at its own genesis timestamp, which
 * is not `Date.now()` — on a node up for a few minutes the two differ by that much. Deriving
 * an "expired" request from wall time produces a request that is not expired, and the attempt
 * then passes the check it was meant to fail. Every time comparison here reads the chain.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, toHex, encodeAbiParameters } from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { signActionRequest, ACTION_LOGGER_ABI } from "@sigilkit/core";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Anvil dev account #1 — public, well-known, and what the demo grants to. */
const DEFAULT_AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/**
 * Resolve `forge`, the way `packages/demo-agent/src/devkeys.ts` does.
 *
 * It is frequently NOT on PATH for a Node child process even when the developer's shell has
 * it — `~/.foundry/bin` is added by the foundry installer to the interactive profile, which a
 * spawned process does not read. Honour FORGE_BIN first, then the standard install location,
 * then fall back to bare `forge` for a CI image that puts it on PATH.
 */
function resolveForge() {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN;
  const binary = process.platform === "win32" ? "forge.exe" : "forge";
  const installed = join(homedir(), ".foundry", "bin", binary);
  return existsSync(installed) ? installed : "forge";
}

function parseArgs(argv) {
  const out = { rpc: "http://127.0.0.1:8545", chainId: 31337, agentKey: DEFAULT_AGENT_KEY };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inlineValue] = argv[i].split("=");
    const value = inlineValue ?? argv[++i];
    switch (flag) {
      case "--manager": out.manager = value; break;
      case "--counter": out.counter = value; break;
      case "--agent-key": out.agentKey = value; break;
      case "--rpc": out.rpc = value; break;
      case "--chain-id": out.chainId = Number(value); break;
      default:
        console.error(`unknown flag: ${flag}`);
        console.error("usage: proof-demo --manager <addr> --counter <addr> [--agent-key <hex>] [--rpc <url>] [--chain-id <n>]");
        process.exit(2);
    }
  }
  if (!out.manager || !out.counter) {
    console.error("usage: proof-demo --manager <addr> --counter <addr> [--agent-key <hex>] [--rpc <url>] [--chain-id <n>]");
    process.exit(2);
  }
  return out;
}

/**
 * The full manager ABI.
 *
 * NOT `SESSION_KEY_MANAGER_ABI` from @sigilkit/core: that is a deliberately minimal subset
 * (the functions the SDK itself calls) and does not contain `getScope`. Reading the deployed
 * contract's real ABI is also the more honest thing for a proof script — it is what the chain
 * says the contract is, not what the SDK believes it is.
 */
function loadAbi(rpc) {
  const cached = process.env.SIGILKIT_MANAGER_ABI;
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, "utf8"));
  const raw = execFileSync(resolveForge(), ["inspect", "SessionKeyManager", "abi", "--json"], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  const out = join(ROOT, "outputs", "proof-demo", "SessionKeyManager.abi.json");
  execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(dirname(out))},{recursive:true})`]);
  writeFileSync(out, raw);
  return JSON.parse(raw);
}

/** viem reports a nested revert's custom-error name in the message; `.data` is undefined. */
function revertReason(err) {
  const message = String(err?.message ?? err);
  const known = [
    "PerActionCapExceeded", "PerWindowCapExceeded", "SelectorDenied", "TargetNotAllowed",
    "NonceUsed", "RequestExpired", "KeyExpired", "OwnerCountersignRequired",
    "InvalidSignature", "InnerCallFailed",
  ];
  for (const name of known) if (message.includes(name)) return name;
  return message.split("\n").find((l) => l.trim())?.trim() ?? "unknown";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const abi = loadAbi();
  const client = createPublicClient({ chain: { ...foundry, id: args.chainId }, transport: http(args.rpc) });
  const agent = privateKeyToAccount(args.agentKey);

  const scope = await client.readContract({ address: args.manager, abi, functionName: "getScope", args: [agent.address] });
  const nextNonce = await client.readContract({ address: args.manager, abi, functionName: "getNonce", args: [agent.address] });
  const chainNow = Number((await client.getBlock({ blockTag: "latest" })).timestamp);

  const rule = "═".repeat(76);
  console.log(rule);
  console.log(" SIGILKIT — SCOPE ENFORCEMENT, DEMONSTRATED ON A LIVE CHAIN");
  console.log(rule);
  console.log(`\n  rpc      ${args.rpc}   chainId ${args.chainId}`);
  console.log(`  manager  ${args.manager}`);
  console.log(`  counter  ${args.counter}`);
  console.log(`  agent    ${agent.address}`);
  console.log(`\n  THE SCOPE THE OWNER GRANTED THAT KEY`);
  console.log(`    perActionCap      ${scope.perActionCap} wei  (${Number(scope.perActionCap) / 1e18} ETH)`);
  console.log(`    perWindowCap      ${scope.perWindowCap} wei  (${Number(scope.perWindowCap) / 1e18} ETH)`);
  console.log(`    windowSeconds     ${scope.windowSeconds}`);
  console.log(`    countersignAbove  ${scope.countersignAbove}`);
  console.log(`    target whitelist  ${scope.merkleRoot === `0x${"0".repeat(64)}` ? "allow-all" : `Merkle-pinned (${scope.merkleRoot.slice(0, 18)}…)`}`);

  const base = { agentId: keccak256(toHex("proof-demo")), expiry: chainNow + 600, rationaleHash: keccak256(toHex("proof")) };

  const attempts = [
    ["spend 10,000 ETH — a million times the per-action cap",
      { ...base, target: args.counter, selector: "0x32145f90", value: 10n ** 24n, nonce: nextNonce, data: "0x" }, "PerActionCapExceeded"],
    ["call transferOwnership — owner-only — through the session key",
      { ...base, target: args.manager, selector: toHex("transferOwnership(address)").slice(0, 10), value: 0n, nonce: nextNonce, data: `0x${"00".repeat(32)}` }, "SelectorDenied or TargetNotAllowed"],
    ["replay a nonce this key already spent",
      { ...base, target: args.counter, selector: "0x32145f90", value: 1n, nonce: 0n, data: "0x" }, "NonceUsed"],
    ["use a request that expired a minute ago",
      { ...base, expiry: chainNow - 60, target: args.counter, selector: "0x32145f90", value: 0n, nonce: nextNonce, data: "0x" }, "RequestExpired"],
  ];

  console.log("\n  ATTEMPTS BY THE AGENT KEY");
  console.log("  Each is signed for real (EIP-712), then simulated with eth_call —");
  console.log("  nothing is broadcast and no chain state changes.\n");

  // POSITIVE CONTROL FIRST. Every other case asserts a REFUSAL, and a suite of only
  // refusals cannot tell "the policy is working" from "this key cannot do anything at all" —
  // a broken deployment, an ungranted key or a wrong ABI would make all four pass for the
  // wrong reason. This one action is inside the granted scope and MUST succeed; if it does
  // not, the four refusals below prove nothing and the run fails.
  console.log("    · control: an action INSIDE the granted scope");
  let controlOk = false;
  try {
    // The counter is `poke(uint256 by)` — `0x32145f90` is its selector, so the calldata must
    // carry one ABI-encoded uint256. Sending `data: "0x"` reaches the target with no argument,
    // the target reverts, and the manager surfaces that as InnerCallFailed — which is a
    // property of MY request, not of the scope enforcement this script is checking.
    const inScope = {
      ...base, target: args.counter, selector: "0x32145f90", value: 1000n, nonce: nextNonce,
      data: encodeAbiParameters([{ type: "uint256" }], [1n]),
    };
    const signature = await signActionRequest({
      account: agent, request: inScope, chainId: args.chainId, verifyingContract: args.manager,
    });
    await client.simulateContract({
      address: args.manager, abi, account: agent,
      functionName: "executeWithSessionKey", args: [inScope, signature, [], "0x"],
    });
    controlOk = true;
    console.log("        accepted on-chain — the key is genuinely able to act.\n");
  } catch (err) {
    console.log(`        REJECTED: ${revertReason(err)}`);
    console.log("        This action is INSIDE the granted scope, so it should have succeeded.");
    console.log("        The refusals below would be meaningless — they would only prove the");
    console.log("        key cannot do anything at all. Stopping here.\n");
    process.exit(1);
  }

  let failures = 0;
  for (const [label, request, expected] of attempts) {
    const signature = await signActionRequest({
      account: agent, request, chainId: args.chainId, verifyingContract: args.manager,
    });
    try {
      await client.simulateContract({
        address: args.manager, abi, account: agent,
        functionName: "executeWithSessionKey", args: [request, signature, [], "0x"],
      });
      failures++;
      console.log(`    ✗ ${label}`);
      console.log(`        ACCEPTED — the agent exceeded its scope. That is a security failure.`);
    } catch (err) {
      const reason = revertReason(err);
      // The guard that fired must be the one we expected, not merely "something reverted".
      // A refusal for an unrelated reason (say InvalidSignature) would otherwise be counted
      // as proof the policy worked, which is the exact false positive this script exists to
      // avoid.
      const expectedOk = expected.split(" or ").includes(reason);
      if (!expectedOk) failures++;
      console.log(`    ${expectedOk ? "✓" : "✗"} ${label}`);
      console.log(`        refused on-chain: ${reason}`);
      if (!expectedOk) {
        console.log(`        expected one of: ${expected}`);
        console.log("        Refused, but NOT by the guard under test — this proves nothing.");
      }
    }
  }

  const logged = await client.getContractEvents({
    address: args.manager, abi: ACTION_LOGGER_ABI, eventName: "ActionLogged", fromBlock: 0n, toBlock: "latest",
  });
  const charged = await client.getContractEvents({
    address: args.manager, abi: ACTION_LOGGER_ABI, eventName: "WindowCharged", fromBlock: 0n, toBlock: "latest",
  });

  console.log("\n  THE AUDIT TRAIL — emitted by the contract, read back from the chain\n");
  console.log(`    ActionLogged   ${logged.length} event(s)   (INV-3: every success is logged)`);
  for (const log of logged) {
    console.log(`      block ${log.blockNumber}  target ${log.args.target}  selector ${log.args.selector}  ${log.args.value} wei`);
  }
  console.log(`\n    WindowCharged  ${charged.length} event(s)   (INV-1: window spend is tracked)`);
  for (const log of charged) {
    console.log(`      charged ${log.args.value}  ->  spentThisWindow ${log.args.spentThisWindow}  (window opened ${log.args.windowStart})`);
  }

  console.log(`\n${rule}`);
  if (failures > 0) {
    console.log(` RESULT: FAILED — ${failures} of ${attempts.length} out-of-scope attempts were either`);
    console.log(" accepted, or refused by a guard other than the one under test. Do not present this.");
    process.exit(1);
  }
  console.log(` RESULT: control accepted, and all ${attempts.length} out-of-scope attempts refused`);
  console.log(" by the specific guard each one was testing for. Both halves matter: the control");
  console.log(" shows the key really can act, so the refusals are the policy working rather than");
  console.log(" a deployment that simply rejects everything.");
  console.log(rule);
}

main().catch((err) => {
  console.error("proof-demo failed:", err?.message ?? err);
  process.exit(1);
});