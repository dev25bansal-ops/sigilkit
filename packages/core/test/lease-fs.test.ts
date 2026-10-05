/**
 * FileLeaseStore v2 tests (ARCH-6, SK-09).
 *
 * The lease store is the only thing standing between a multi-worker deployment and two
 * workers racing the same on-chain nonce, so it is tested against real SQLite semantics:
 * token-based ownership, epoch fencing, renewal, stale recovery, and the NonceGate
 * integration that fails loudly instead of racing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import type { LeaseToken } from "../src/client.js";
import type { Address } from "viem";
import { NonceGate, SigilKitClient } from "../src/index.js";
import { FileLeaseStore } from "../src/lease-fs.js";
import { foundry } from "viem/chains";

const KEY = "0x00000000000000000000000000000000000000aa" as Address;

let dir: string;
const open: FileLeaseStore[] = [];

beforeEach(() => {
  dir = join(tmpdir(), `sigilkit-lease-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  while (open.length) open.pop()?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Tracks stores so afterEach can close SQLite handles before the directory removal. */
function store(options?: ConstructorParameters<typeof FileLeaseStore>[1]): FileLeaseStore {
  const s = new FileLeaseStore(dir, options);
  open.push(s);
  return s;
}

describe("FileLeaseStore v2 ownership", () => {
  it("atomically preserves the current owner across stale release and renewal", () => {
    vi.useFakeTimers();
    const a = store({ staleGraceMs: 0 });
    const b = store({ staleGraceMs: 0 });
    try {
      const first = a.acquire(KEY, 100);
      expect(first).not.toBeNull();
      expect(b.acquire(KEY, 100)).toBeNull();
      vi.advanceTimersByTime(101);
      const second = b.acquire(KEY, 100);
      if (!first || !second) throw new Error("Expected lease tokens");
      expect(second.epoch).toBeGreaterThan(first.epoch);
      expect(a.release(first)).toBe(false);
      expect(a.renew(first, 100)).toBe(false);
      expect(a.isCurrent(first)).toBe(false);
      expect(b.isCurrent(second)).toBe(true);
      expect(b.renew(second, 200)).toBe(true);
      vi.advanceTimersByTime(150);
      expect(b.isCurrent(second)).toBe(true);
      expect(b.release(second)).toBe(true);
      expect(b.release(second)).toBe(false);
      const third = a.acquire(KEY, 100);
      expect(third?.epoch).toBeGreaterThan(second.epoch);
    } finally {
      vi.useRealTimers();
    }
  });

  it("grants the lease once and refuses a second holder", () => {
    const a = store();
    const b = store(); // a second "worker" on the same host

    const token = a.acquire(KEY, 30_000);
    expect(token).not.toBeNull();
    expect(b.acquire(KEY, 30_000), "a held lease must not be granted twice").toBeNull();
    expect(b.isHeld(KEY)).toBe(true);

    if (!token) throw new Error("Expected lease token");
    expect(a.release(token)).toBe(true);
    expect(b.acquire(KEY, 30_000), "after release the lease is available").not.toBeNull();
  });

  it("scopes leases per key", () => {
    const other = "0x00000000000000000000000000000000000000bb" as Address;
    const s = store();
    expect(s.acquire(KEY, 30_000)).not.toBeNull();
    expect(s.acquire(other, 30_000), "a different key must not be blocked").not.toBeNull();
  });

  it("recovers a lease abandoned by a crashed holder past its TTL", () => {
    vi.useFakeTimers();
    try {
      const crashed = store({ staleGraceMs: 1_000 });
      const survivor = store({ staleGraceMs: 1_000 });

      expect(crashed.acquire(KEY, 5_000)).not.toBeNull();
      // The holder dies without releasing.
      expect(survivor.acquire(KEY, 5_000), "still within TTL — must not be stolen").toBeNull();

      vi.advanceTimersByTime(10_000); // past TTL + grace
      expect(survivor.acquire(KEY, 5_000), "an abandoned lease must be reclaimable").not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers after forced termination of an independent holder without accepting its stale token", async () => {
    const survivor = store({ staleGraceMs: 1_000 });
    const moduleUrl = new URL("../dist/lease-fs.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import { FileLeaseStore } from ${JSON.stringify(moduleUrl)};
      const store = new FileLeaseStore(process.argv[1], { staleGraceMs: 1000 });
      const token = store.acquire(process.argv[2], 5000);
      if (!token) throw new Error("Fixture acquisition failed");
      process.send({ token, pid: process.pid });
      setInterval(() => {}, 1000);
    `, dir, KEY], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
    try {
      const message = await new Promise<{ token: LeaseToken; pid: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Lease child readiness timed out")), 5000);
        child.once("message", (value) => {
          clearTimeout(timer);
          resolve(value as { token: LeaseToken; pid: number });
        });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Lease child exited before readiness: ${stderr}`));
        });
      });
      expect(message.pid).toBe(child.pid);
      expect(message.pid).not.toBe(process.pid);
      expect(survivor.isCurrent(message.token)).toBe(true);
      expect(survivor.acquire(KEY, 5000)).toBeNull();
      const row = survivor["db"].prepare("SELECT expires, reclaim_after FROM leases WHERE key = ?").get(KEY) as {
        expires: number; reclaim_after: number;
      };
      expect(child.kill("SIGKILL")).toBe(true);
      await closed;
      expect(Date.now()).toBeLessThan(row.expires);
      expect(survivor.acquire(KEY, 5000)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, row.expires - Date.now()) + 20));
      expect(survivor.isCurrent(message.token)).toBe(false);
      expect(Date.now()).toBeLessThan(row.reclaim_after);
      expect(survivor.acquire(KEY, 5000)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, row.reclaim_after - Date.now()) + 20));
      const replacement = survivor.acquire(KEY, 5000);
      expect(replacement).not.toBeNull();
      expect(replacement!.epoch).toBe(message.token.epoch + 1);
      expect(survivor.renew(message.token, 5000)).toBe(false);
      expect(survivor.release(message.token)).toBe(false);
      expect(survivor.isCurrent(replacement!)).toBe(true);
      expect(survivor.release(replacement!)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }, 20_000);

  it("refuses a legacy v1 lock directory instead of breaking it (migration safety)", () => {
    mkdirSync(join(dir, `${KEY}.lock`));
    writeFileSync(join(dir, `${KEY}.lock`, "expires"), String(Date.now() + 60_000));
    expect(() => store()).toThrow(/legacy lease directory/);
    // The legacy artifact is left untouched for the operator to migrate.
  });

  it("rejects invalid TTLs and tokens", () => {
    const s = store();
    expect(() => s.acquire(KEY, 5)).toThrow(/lease TTL/);
    expect(() => s.acquire(KEY, Number.NaN)).toThrow(/lease TTL/);
    const token = s.acquire(KEY, 1_000);
    if (!token) throw new Error("Expected lease token");
    expect(() => s.isCurrent({ ...token, epoch: token.epoch + 1 })).not.toThrow();
    expect(s.isCurrent({ ...token, epoch: token.epoch + 1 })).toBe(false);
  });

  it("NonceGate fails loudly when another worker holds the lease", async () => {
    const holder = store();
    const token = holder.acquire(KEY, 30_000);
    if (!token) throw new Error("Expected lease token");

    const gate = new NonceGate(store());
    await expect(gate.run(KEY, async () => "never")).rejects.toThrow(/busy in another worker/);

    holder.release(token);
    await expect(gate.run(KEY, async () => "ok")).resolves.toBe("ok");
  });

  it("persists epochs through release and connection reopening", () => {
    const a = store();
    const first = a.acquire(KEY, 1000)!;
    expect(a.release(first)).toBe(true);
    a.close();
    a.close();
    const b = store();
    const second = b.acquire(KEY, 1000)!;
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(b.release(first)).toBe(false);
    expect(b.isCurrent(second)).toBe(true);
  });

  it("uses holder grace but never renews at or after exact expiry", () => {
    vi.useFakeTimers();
    try {
      const a = store({ staleGraceMs: 200 });
      const b = store({ staleGraceMs: 0 });
      const token = a.acquire(KEY, 100)!;
      expect(b.acquire(KEY.toUpperCase().replace("0X", "0x") as Address, 100)).toBeNull();
      vi.advanceTimersByTime(100);
      expect(a.isCurrent(token)).toBe(false);
      expect(a.renew(token, 100)).toBe(false);
      expect(b.isHeld(KEY)).toBe(true);
      expect(b.acquire(KEY, 100)).toBeNull();
      vi.advanceTimersByTime(200);
      expect(b.acquire(KEY, 100)?.epoch).toBeGreaterThan(token.epoch);
    } finally { vi.useRealTimers(); }
  });

  it("rejects invalid time arithmetic without mutating ownership", () => {
    const a = store();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    try { expect(() => a.acquire(KEY, 100)).toThrow("time arithmetic"); }
    finally { clock.mockRestore(); }
    expect(a.acquire(KEY, 100)).not.toBeNull();
    expect(() => store({ staleGraceMs: -1 })).toThrow("grace");
  });

  it("rejects a missing directory when creation is disabled and corrupt SQLite", () => {
    expect(() => new FileLeaseStore(join(dir, "missing"), { createDir: false })).toThrow();
    writeFileSync(join(dir, "leases-v2.sqlite"), "synthetic invalid database");
    expect(() => store()).toThrow();
  });

  it("rejects wrong key, owner, and epoch mutations without altering the live owner", () => {
    const a = store();
    const token = a.acquire(KEY, 1000)!;
    for (const other of [
      { ...token, key: "0x00000000000000000000000000000000000000bb" as Address },
      { ...token, id: "synthetic-other-owner" },
      { ...token, epoch: token.epoch + 1 },
    ]) {
      expect(a.renew(other, 1000)).toBe(false);
      expect(a.release(other)).toBe(false);
      expect(a.isCurrent(other)).toBe(false);
    }
    expect(a.isCurrent(token)).toBe(true);
  });

  it.each(["acquire", "renew", "release"] as const)("preserves ownership and retries after a writer blocks %s", (operation) => {
    const a = store();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const blocker = new DatabaseSync(join(dir, "leases-v2.sqlite"));
    try {
      a["db"].exec("PRAGMA busy_timeout = 0");
      const token = a.acquire(KEY, 30_000)!;
      const before = a["db"].prepare("SELECT * FROM leases WHERE key = ?").get(KEY);
      const attempt = () => operation === "acquire" ? a.acquire(KEY, 60_000)
        : operation === "renew" ? a.renew(token, 60_000) : a.release(token);
      blocker.exec("BEGIN IMMEDIATE");
      expect(attempt).toThrow(expect.objectContaining({ errcode: 5 }));
      expect(a["db"].prepare("SELECT * FROM leases WHERE key = ?").get(KEY)).toEqual(before);
      blocker.exec("ROLLBACK");
      if (operation === "acquire") {
        expect(attempt()).toBeNull();
        expect(a.release(token)).toBe(true);
        expect(a.acquire(KEY, 60_000)?.epoch).toBe(token.epoch + 1);
      } else {
        expect(attempt()).toBe(true);
        expect(a.isCurrent(token)).toBe(operation === "renew");
      }
    } finally {
      if (blocker.isTransaction) blocker.exec("ROLLBACK");
      blocker.close();
      clock.mockRestore();
    }
  });

  it.each(["acquire", "renew"] as const)("rolls back a reader-blocked %s commit and retries on the same connection", (operation) => {
    const a = store();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const reader = new DatabaseSync(join(dir, "leases-v2.sqlite"));
    const db = a["db"];
    let exec: ReturnType<typeof vi.spyOn> | undefined;
    try {
      db.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0");
      const token = a.acquire(KEY, 30_000)!;
      if (operation === "acquire") expect(a.release(token)).toBe(true);
      const before = db.prepare("SELECT * FROM leases WHERE key = ?").get(KEY);
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM leases WHERE key = ?").get(KEY);
      exec = vi.spyOn(db, "exec");
      const attempt = () => operation === "acquire" ? a.acquire(KEY, 60_000) : a.renew(token, 60_000);
      expect(attempt).toThrow(expect.objectContaining({ errcode: 5 }));
      expect(exec.mock.calls).toEqual([["BEGIN IMMEDIATE"], ["COMMIT"], ["ROLLBACK"]]);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT * FROM leases WHERE key = ?").get(KEY)).toEqual(before);
      reader.exec("ROLLBACK");
      expect(reader.prepare("SELECT * FROM leases WHERE key = ?").get(KEY)).toEqual(before);
      const result = attempt();
      if (operation === "acquire") {
        expect(result).toEqual(expect.objectContaining({ key: KEY, epoch: token.epoch + 1 }));
      } else {
        expect(result).toBe(true);
        expect(db.prepare("SELECT * FROM leases WHERE key = ?").get(KEY)).toEqual({
          key: KEY, owner: token.id, epoch: token.epoch, expires: 1_060_000, reclaim_after: 1_065_000,
        });
      }
    } finally {
      exec?.mockRestore();
      if (reader.isTransaction) reader.exec("ROLLBACK");
      reader.close();
      clock.mockRestore();
    }
  });

  it("rolls back a commit blocked by a separate reader process and retries", async () => {
    const a = store();
    const db = a["db"];
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0");
    const original = a.acquire(KEY, 30_000)!;
    expect(a.release(original)).toBe(true);
    const before = db.prepare("SELECT * FROM leases WHERE key = ?").get(KEY);
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN");
      db.prepare("SELECT * FROM leases WHERE key = ?").get(process.argv[2]);
      process.send({ pid: process.pid });
      process.once("message", () => {
        db.exec("ROLLBACK");
        db.close();
        process.disconnect();
      });
    `, join(dir, "leases-v2.sqlite"), KEY], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
    const exec = vi.spyOn(db, "exec");
    try {
      const message = await new Promise<{ pid: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Reader process readiness timed out")), 5000);
        child.once("message", (value) => { clearTimeout(timer); resolve(value as { pid: number }); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Reader exited before readiness")); });
      });
      expect(message.pid).toBe(child.pid);
      expect(message.pid).not.toBe(process.pid);
      expect(() => a.acquire(KEY, 30_000)).toThrow(expect.objectContaining({ errcode: 5 }));
      expect(exec.mock.calls).toEqual([["BEGIN IMMEDIATE"], ["COMMIT"], ["ROLLBACK"]]);
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT * FROM leases WHERE key = ?").get(KEY)).toEqual(before);
      await new Promise<void>((resolve, reject) => {
        child.send("release", (error) => error ? reject(error) : resolve());
      });
      await closed;
      expect(child.exitCode).toBe(0);
      const replacement = a.acquire(KEY, 30_000)!;
      expect(replacement.epoch).toBe(original.epoch + 1);
      expect(a.isCurrent(replacement)).toBe(true);
      expect(a.release(replacement)).toBe(true);
    } finally {
      exec.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  }, 10_000);

  it("SigilKitClient accepts a lease store through its config", () => {
    const client = new SigilKitClient({
      managerAddress: KEY,
      chain: foundry,
      leaseStore: store(),
    });
    expect(client.nonceGate).toBeInstanceOf(NonceGate);
  });
});
