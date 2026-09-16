import { describe, expect, it } from "vitest";
import {
  CliUsageError,
  EXIT_OK,
  EXIT_RUNTIME,
  EXIT_USAGE,
  helpText,
  parseArgs,
  parseCli,
  runCli,
  UserError,
  type CliIo,
  type CliSpec,
} from "../src/cli.js";

const ALICE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const SPEC: CliSpec = {
  name: "demo-cli",
  version: "1.2.3",
  summary: "A test CLI.",
  usage: ["demo-cli <command> [options]"],
  commands: [
    { name: "run", description: "Do the thing" },
    { name: "list", description: "List the things" },
  ],
  flags: [
    { name: "--rpc", alias: "-r", value: "<url>", description: "Endpoint" },
    { name: "--db", value: "<path>", description: "Database", default: "audit.db" },
    { name: "--agent", value: "<hash>", description: "Agent id" },
    { name: "--limit", value: "<n>", description: "Row limit" },
    { name: "--json", description: "JSON output" },
    { name: "--mode", value: "<mode>", description: "Mode", choices: ["fast", "slow"] },
    { name: "--needed", value: "<v>", description: "Required", required: true },
  ],
  examples: ["demo-cli run --rpc http://127.0.0.1:8545"],
  notes: ["EXIT CODES", "  0 ok"],
};

describe("parseArgs", () => {
  it("accepts --flag value and --flag=value", () => {
    const a = parseArgs(["run", "--needed", "x", "--rpc", "http://x", "--db=/tmp/a.db"], SPEC.flags);
    expect(a.get("--rpc")).toBe("http://x");
    expect(a.get("--db")).toBe("/tmp/a.db");
    expect(a.positionals).toEqual(["run"]);
  });

  it("supports short aliases", () => {
    expect(parseArgs(["--needed", "x", "-r", "http://y"], SPEC.flags).get("--rpc")).toBe("http://y");
  });

  it("applies defaults and reports presence", () => {
    const a = parseArgs(["--needed", "x"], SPEC.flags);
    expect(a.get("--db")).toBe("audit.db");
    expect(a.has("--db")).toBe(true);
    expect(a.has("--json")).toBe(false);
  });

  it("accumulates repeated flags", () => {
    const a = parseArgs(["--needed", "x", "--rpc", "a", "--rpc", "b"], SPEC.flags);
    expect(a.all("--rpc")).toEqual(["a", "b"]);
    expect(a.get("--rpc")).toBe("b");
  });

  it("treats boolean flags as presence", () => {
    expect(parseArgs(["--needed", "x", "--json"], SPEC.flags).has("--json")).toBe(true);
  });

  it("rejects a value given to a boolean flag", () => {
    expect(() => parseArgs(["--needed", "x", "--json=1"], SPEC.flags)).toThrow(/does not take a value/);
  });

  it("rejects an unknown flag and suggests the closest known one", () => {
    expect(() => parseArgs(["--dbb", "x"], SPEC.flags)).toThrow(/unknown option --dbb/);
    expect(() => parseArgs(["--dbb", "x"], SPEC.flags)).toThrow(/did you mean --db/);
  });

  it("rejects a missing value", () => {
    expect(() => parseArgs(["--needed"], SPEC.flags)).toThrow(/--needed requires a value/);
    expect(() => parseArgs(["--rpc", "--json"], SPEC.flags)).toThrow(/--rpc requires a value/);
  });

  it("rejects a value outside the declared choices", () => {
    expect(() => parseArgs(["--needed", "x", "--mode", "medium"], SPEC.flags)).toThrow(/must be one of fast \| slow/);
  });

  it("reports every missing required flag at once", () => {
    expect(() => parseArgs([], SPEC.flags)).toThrow(/missing required option\(s\): --needed/);
  });

  it("treats everything after -- as positional", () => {
    const a = parseArgs(["--needed", "x", "--", "--json", "tail"], SPEC.flags);
    expect(a.positionals).toEqual(["--json", "tail"]);
    expect(a.has("--json")).toBe(false);
  });

  it("accepts negative numbers as values", () => {
    expect(parseArgs(["--needed", "x", "--limit", "-5"], SPEC.flags).get("--limit")).toBe("-5");
  });
});

describe("typed getters", () => {
  it("validate and surface failures as usage errors", () => {
    const a = parseArgs(["--needed", "x", "--limit", "abc"], SPEC.flags);
    expect(() => a.int("--limit")).toThrow(CliUsageError);
  });

  it("validate addresses, hashes and urls", () => {
    const ok = parseArgs(["--needed", "x", "--rpc", "http://x", "--agent", "0x" + "ab".repeat(32)], SPEC.flags);
    expect(ok.url("--rpc")).toBe("http://x");
    expect(ok.hash32("--agent")).toBe("0x" + "ab".repeat(32));

    const bad = parseArgs(["--needed", "x", "--agent", "nope"], SPEC.flags);
    expect(() => bad.hash32("--agent")).toThrow(/32 bytes/);
  });

  it("validates addresses", () => {
    const a = parseArgs(["--needed", "x", "--rpc", "http://x", "--agent", ALICE], SPEC.flags);
    expect(a.address("--agent")).toBe(ALICE);
  });

  it("returns undefined for absent optional flags", () => {
    const a = parseArgs(["--needed", "x"], SPEC.flags);
    expect(a.int("--limit")).toBeUndefined();
    expect(a.url("--rpc")).toBeUndefined();
    expect(a.oneOf("--mode", ["fast"] as const)).toBeUndefined();
  });
});

describe("parseCli", () => {
  it("returns help before validating anything else", () => {
    expect(parseCli(["--help"], SPEC)).toEqual({ kind: "help" });
    expect(parseCli(["-h"], SPEC)).toEqual({ kind: "help" });
    expect(parseCli(["--help", "--bogus"], SPEC)).toEqual({ kind: "help" });
  });

  it("returns version", () => {
    expect(parseCli(["--version"], SPEC)).toEqual({ kind: "version" });
    expect(parseCli(["-V"], SPEC)).toEqual({ kind: "version" });
  });

  it("resolves a known command", () => {
    const inv = parseCli(["list", "--needed", "x"], SPEC);
    expect(inv.kind).toBe("run");
    if (inv.kind === "run") expect(inv.command).toBe("list");
  });

  it("requires a command when the spec declares commands", () => {
    expect(() => parseCli(["--needed", "x"], SPEC)).toThrow(/a command is required/);
  });

  it("rejects an unknown command and lists the valid ones", () => {
    expect(() => parseCli(["bogus", "--needed", "x"], SPEC)).toThrow(/unknown command "bogus"/);
    expect(() => parseCli(["bogus", "--needed", "x"], SPEC)).toThrow(/run \| list/);
  });
});

describe("helpText", () => {
  it("renders every section", () => {
    const text = helpText(SPEC);
    expect(text).toContain("demo-cli 1.2.3");
    expect(text).toContain("USAGE");
    expect(text).toContain("COMMANDS");
    expect(text).toContain("OPTIONS");
    expect(text).toContain("EXAMPLES");
    expect(text).toContain("EXIT CODES");
    expect(text).toContain("-r, --rpc <url>");
  });
});

/** Captures what a CLI wrote and which exit code it requested. */
function capture(): { io: CliIo; out: string[]; err: string[]; codes: number[] } {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  return {
    io: {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      exit: (c) => codes.push(c),
    },
    out,
    err,
    codes,
  };
}

describe("runCli", () => {
  it("prints help and exits 0", async () => {
    const c = capture();
    await runCli(SPEC, ["--help"], () => 0, { io: c.io });
    expect(c.codes).toEqual([EXIT_OK]);
    expect(c.out.join("\n")).toContain("USAGE");
  });

  it("prints the version and exits 0", async () => {
    const c = capture();
    await runCli(SPEC, ["--version"], () => 0, { io: c.io });
    expect(c.codes).toEqual([EXIT_OK]);
    expect(c.out).toEqual(["1.2.3"]);
  });

  it("runs main and exits with its return code", async () => {
    const c = capture();
    let seen: string | undefined;
    await runCli(SPEC, ["run", "--needed", "x"], (args, cmd) => {
      seen = cmd;
      expect(args.get("--db")).toBe("audit.db");
      return 0;
    }, { io: c.io });
    expect(seen).toBe("run");
    expect(c.codes).toEqual([EXIT_OK]);
  });

  it("exits 2 with a pointer to --help on a usage error", async () => {
    const c = capture();
    await runCli(SPEC, ["--bogus"], () => 0, { io: c.io });
    expect(c.codes).toEqual([EXIT_USAGE]);
    expect(c.err.join("\n")).toContain("unknown option --bogus");
    expect(c.err.join("\n")).toContain("demo-cli --help");
  });

  it("exits 1 and prints the message (no stack) for a UserError", async () => {
    const c = capture();
    await runCli(SPEC, ["run", "--needed", "x"], () => {
      throw new UserError("node unreachable", "start anvil");
    }, { io: c.io });
    expect(c.codes).toEqual([EXIT_RUNTIME]);
    expect(c.err.join("\n")).toContain("error: node unreachable");
    expect(c.err.join("\n")).toContain("hint: start anvil");
    expect(c.err.join("\n")).not.toContain("at ");
  });

  it("exits 1 and prints a stack for an unexpected error", async () => {
    const c = capture();
    await runCli(SPEC, ["run", "--needed", "x"], () => {
      throw new Error("boom");
    }, { io: c.io });
    expect(c.codes).toEqual([EXIT_RUNTIME]);
    expect(c.err.join("\n")).toContain("error: boom");
    expect(c.err.join("\n")).toContain("cli.test.ts");
  });

  it("handles a thrown non-Error", async () => {
    const c = capture();
    await runCli(SPEC, ["run", "--needed", "x"], () => {
      throw "plain string";
    }, { io: c.io });
    expect(c.codes).toEqual([EXIT_RUNTIME]);
    expect(c.err.join("\n")).toContain("error: plain string");
  });

  it("awaits async main", async () => {
    const c = capture();
    await runCli(SPEC, ["run", "--needed", "x"], async () => {
      await Promise.resolve();
      return 7;
    }, { io: c.io });
    expect(c.codes).toEqual([7]);
  });
});
