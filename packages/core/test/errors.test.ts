/**
 * E4 structured revert decoding: decodeSigilKitError over crafted revert data, and
 * decorateWithDecodedRevert walking wrapped viem-style errors.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import { decodeSigilKitError, decorateWithDecodedRevert } from "../src/index.js";

function errorData(signature: string, args: readonly unknown[] = [], types: readonly string[] = []): Hex {
  const selector = keccak256(toHex(signature)).slice(0, 10) as Hex;
  const body =
    types.length > 0
      ? encodeAbiParameters(types.map((t) => ({ type: t })), args as never[])
      : "0x";
  return (selector + body.slice(2)) as Hex;
}

describe("decodeSigilKitError", () => {
  it("decodes known SigilKit errors with named args", () => {
    const data = errorData(
      "PerActionCapExceeded(uint256,uint256)",
      [1200n, 500n],
      ["uint256", "uint256"],
    );
    const decoded = decodeSigilKitError(data);
    expect(decoded.name).toBe("PerActionCapExceeded");
    expect(decoded.args).toEqual([1200n, 500n]);
    expect(decoded.message).toBe("PerActionCapExceeded(1200, 500)");
  });

  it("decodes zero-arg errors", () => {
    const decoded = decodeSigilKitError(errorData("NonceUsed()"));
    expect(decoded.name).toBe("NonceUsed");
    expect(decoded.message).toBe("NonceUsed");
  });

  it("decodes typed-arg errors like TargetNotAllowed", () => {
    const data = errorData(
      "TargetNotAllowed(address,bytes4)",
      ["0x00000000000000000000000000000000000000aa", "0x32145f90"],
      ["address", "bytes4"],
    );
    const decoded = decodeSigilKitError(data);
    expect(decoded.name).toBe("TargetNotAllowed");
    expect(String(decoded.args![0]).toLowerCase()).toContain("aa");
    expect(decoded.args![1]).toBe("0x32145f90");
  });

  it("returns UnknownError for third-party selectors, preserving raw data", () => {
    const data = errorData("SomeThirdPartyError(uint256)", [1n], ["uint256"]);
    const decoded = decodeSigilKitError(data);
    expect(decoded.name).toBe("UnknownError");
    expect(decoded.raw).toBe(data);
  });
});

describe("decorateWithDecodedRevert", () => {
  it("walks wrapped error causes and decorates with the decoded reason", () => {
    const revertData = errorData(
      "PerWindowCapExceeded(uint256,uint256)",
      [3n * 10n ** 18n, 2n * 10n ** 18n],
      ["uint256", "uint256"],
    );
    const leaf = new Error("execution reverted");
    (leaf as unknown as { data: string }).data = revertData;
    const wrapped = new Error("Call Execution Error", { cause: leaf });

    const decorated = decorateWithDecodedRevert(wrapped);
    expect(decorated.name).toBe("PerWindowCapExceeded");
    expect(decorated.message).toContain("PerWindowCapExceeded(3000000000000000000, 2000000000000000000)");
  });

  it("leaves unknown errors untouched", () => {
    const e = new Error("plain failure");
    expect(decorateWithDecodedRevert(e).message).toBe("plain failure");
  });
});
