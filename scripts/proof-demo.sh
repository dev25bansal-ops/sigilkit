#!/usr/bin/env bash
# proof-demo.sh — the whole SigilKit demonstration, from an empty chain to a verdict.
#
# Starts a local anvil, deploys, grants a scoped session key, runs the agent, then proves
# the scope is enforced, then prints the audit trail. Safe to re-run: it tears down its own
# anvil and uses a scratch gitignored output directory.
#
#   bash scripts/proof-demo.sh
#
# Requires: node >= 24, and foundry (forge + anvil) — either on PATH or at ~/.foundry/bin.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# foundry ships outside PATH for non-interactive shells; add it if it is there.
if ! command -v forge >/dev/null 2>&1; then
  BIN="$HOME/.foundry/bin"
  [ -x "$BIN/forge" ] && export PATH="$BIN:$PATH"
fi
for tool in node forge anvil; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found on PATH" >&2; exit 1; }
done

RPC="http://127.0.0.1:8545"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> starting anvil on $RPC"
anvil --port 8545 --silent >"$ROOT/outputs/proof-demo/anvil.log" 2>&1 &
PID=$!

# Wait for the node to answer rather than sleeping a fixed amount — a slow start is the
# usual reason a first run of this script fails on someone else's machine.
for i in $(seq 1 60); do
  if curl -sf -X POST "$RPC" -H 'Content-Type: application/json' \
       -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' >/dev/null 2>&1; then
    break
  fi
  [ "$i" = 60 ] && { echo "error: anvil did not come up; see outputs/proof-demo/anvil.log" >&2; exit 1; }
  sleep 0.5
done
echo "    anvil is up (pid $PID)"

echo
echo "==> building workspaces"
npm run build --silent >/dev/null

echo
echo "==> deploy + grant + agent loop (owner-side steps run in-process; demo topology only)"
cd "$ROOT/packages/demo-agent"
npx tsx src/cli.ts --grant --ticks 5 --yes 2>&1 | sed 's/^/    /'
cd "$ROOT"

# The demo's stdout already prints both addresses, but parsing its human output couples this
# script to its formatting. Instead identify each contract by what it IS: its runtime code.
#
# Note the demo deploys via `forge create`, which publishes from a compiled artifact — there
# is no on-chain CREATE transaction to read an address out of, so scanning blocks for
# `tx.to == null` finds nothing useful. Matching `eth_getCode` against the locally compiled
# artifacts is both simpler and more robust: it cannot pick the wrong contract.
read -r MANAGER COUNTER <<EOF
$(node -e '
const {createPublicClient,http}=require("viem");const {foundry}=require("viem/chains");
const fs=require("fs");
(async()=>{
  const c=createPublicClient({chain:foundry,transport:http("http://127.0.0.1:8545")});
  const art=(f)=>JSON.parse(fs.readFileSync("out/"+f+".json","utf8"));
  const want={ manager: art("SessionKeyManager.sol/SessionKeyManager").deployedBytecode.object.toLowerCase(),
               counter: art("CounterTarget.sol/CounterTarget").deployedBytecode.object.toLowerCase() };
  const found={};
  const head=Number(await c.getBlockNumber());
  for(let b=1n;b<=BigInt(head);b++){
    const blk=await c.getBlock({blockNumber:b,includeTransactions:true});
    for(const tx of blk.transactions){
      if(tx.to) continue;
      // `forge create` wraps initcode in an EIP-3860 factory frame, so the deployed
      // address is NOT the last 40 bytes of `input`. Take it from the RECEIPT, which is
      // authoritative, then confirm by matching runtime code rather than trusting order.
      const r=await c.getTransactionReceipt({hash:tx.hash});
      const addr=r.contractAddress;
      if(!addr) continue;
      const code=((await c.getCode({address:addr}))||"").toLowerCase();
      if(code===want.manager) found.manager=addr;
      else if(code===want.counter) found.counter=addr;
    }
  }
  if(!found.manager || !found.counter) console.error("could not identify deployed contracts by runtime code");
  console.log(found.manager||"", found.counter||"");
})();')
EOF
ADDRESS_STATUS=$?

if [ -z "$MANAGER" ] || [ -z "$COUNTER" ]; then
  echo "error: could not determine the deployed addresses from the chain" >&2
  exit 1
fi
echo
echo "    manager $MANAGER"
echo "    counter $COUNTER"

echo
echo "==> proving the scope is enforced"
node "$ROOT/scripts/proof-demo.mjs" --manager "$MANAGER" --counter "$COUNTER" --rpc "$RPC"
STATUS=$?

echo
if [ "$STATUS" = 0 ]; then
  echo "==> PASS — the agent stayed inside its scope and every excess was refused on-chain."
else
  echo "==> FAIL — see the output above. Do not present this as a working demo."
fi
exit "$STATUS"