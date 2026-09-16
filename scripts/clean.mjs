#!/usr/bin/env node
/**
 * Removes generated artifacts (CQ-6).
 *
 * The wallet-e2e harness alone leaves ~100 MB on disk (a 21.7 MB extension zip, its extracted
 * tree, a Playwright profile) plus Foundry's out/cache and the packages' dist trees. All of it
 * is reproducible, none of it is source. Run this to reclaim the space; nothing tracked by git
 * is touched.
 *
 *   node scripts/clean.mjs          # remove generated artifacts
 *   node scripts/clean.mjs --dry    # list what would be removed
 */
import { existsSync, rmSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry");

/** Workspace packages — kept in one place so per-package artifacts cannot drift apart. */
const PACKAGES = ["core", "indexer", "mcp", "demo-agent"];

/** Generated paths, relative to the repo root. Never add a tracked source path here. */
const TARGETS = [
  "out",
  "cache",
  "broadcast",
  "coverage",
  ...PACKAGES.map((p) => `packages/${p}/dist`),
  // Every package writes a coverage report; listing only core left three behind.
  ...PACKAGES.map((p) => `packages/${p}/coverage`),
  "packages/core/test-results",
  "packages/demo-agent/fleet-manifest.json",
  "packages/core/test/wallet-e2e/metamask",
  "packages/core/test/wallet-e2e/metamask.zip",
  "packages/core/test/wallet-e2e/.playwright-profile",
  "packages/core/test/wallet-e2e/.coinbase-out",
];

function dirSize(p) {
  const st = statSync(p);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
let total = 0;
let removed = 0;

for (const rel of TARGETS) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const size = dirSize(abs);
  total += size;
  removed++;
  if (DRY) {
    console.log(`would remove  ${rel.padEnd(48)} ${mb(size)}`);
  } else {
    rmSync(abs, { recursive: true, force: true });
    console.log(`removed  ${rel.padEnd(48)} ${mb(size)}`);
  }
}

if (removed === 0) {
  console.log("nothing to clean — no generated artifacts found.");
} else {
  console.log(`\n${DRY ? "would reclaim" : "reclaimed"} ${mb(total)} across ${removed} path(s).`);
}
