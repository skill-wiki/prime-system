import { describe, expect, test } from "bun:test";
import { NO_CAPABILITIES, authorizeCapabilities, capabilityNamespace, capabilitySegments, checkCapability, isWellFormedCapability } from "../src/capabilities.ts";

describe("capability grammar (§12.1 shape, open vocabulary)", () => {
  test("the two §12.1 examples are well-formed", () => {
    expect(isWellFormedCapability("network:https")).toBe(true);
    expect(isWellFormedCapability("secrets:read:scoped")).toBe(true);
  });

  test("a hostname qualifier is expressible", () => {
    expect(isWellFormedCapability("network:https:api.example.com")).toBe(true);
  });

  /**
   * The vocabulary must stay open: a capability nobody has invented yet has to
   * parse, otherwise adding an adapter means editing the engine (§3.1).
   */
  test("an unheard-of namespace is still well-formed", () => {
    expect(isWellFormedCapability("quantum-ledger:append")).toBe(true);
  });

  test("a single segment is not a capability", () => {
    expect(isWellFormedCapability("network")).toBe(false);
  });

  test("uppercase is refused so one grant has one spelling", () => {
    expect(isWellFormedCapability("Network:HTTPS")).toBe(false);
  });

  test("empty segments and stray colons are refused", () => {
    expect(isWellFormedCapability("network:")).toBe(false);
    expect(isWellFormedCapability(":read")).toBe(false);
    expect(isWellFormedCapability("a::b")).toBe(false);
  });

  test("segments and namespace are readable", () => {
    expect(capabilitySegments("secrets:read:scoped")).toEqual(["secrets", "read", "scoped"]);
    expect(capabilityNamespace("secrets:read:scoped")).toBe("secrets");
  });
});

describe("authorizeCapabilities — deny-by-default, two independent gates (§3.5)", () => {
  test("nothing is granted when the operator grants nothing", () => {
    const { grants } = authorizeCapabilities(["network:https"], []);
    expect([...grants.granted]).toEqual([]);
    expect(checkCapability(grants, "network:https").granted).toBe(false);
  });

  test("an empty grant set refuses everything", () => {
    expect(checkCapability(NO_CAPABILITIES, "network:https").granted).toBe(false);
  });

  test("a capability declared AND granted is exercisable", () => {
    const { grants } = authorizeCapabilities(["network:https"], ["network:https"]);
    expect(checkCapability(grants, "network:https").granted).toBe(true);
  });

  /**
   * The gate that stops an over-broad operator configuration from arming a
   * plugin that never published the claim.
   */
  test("a grant the plugin never declared is dropped, and reported", () => {
    const result = authorizeCapabilities(["network:https"], ["network:https", "secrets:read:all"]);
    expect([...result.grants.granted]).toEqual(["network:https"]);
    expect(result.grantsWithoutDeclaration).toEqual(["secrets:read:all"]);
    const decision = checkCapability(result.grants, "secrets:read:all");
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe("CAPABILITY_NOT_DECLARED");
  });

  test("a declaration the operator did not grant is refused, and reported", () => {
    const result = authorizeCapabilities(["network:https", "secrets:read:scoped"], ["network:https"]);
    expect(result.declarationsWithoutGrant).toEqual(["secrets:read:scoped"]);
    const decision = checkCapability(result.grants, "secrets:read:scoped");
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe("CAPABILITY_NOT_GRANTED");
  });

  test("malformed capabilities are surfaced, not silently dropped", () => {
    const result = authorizeCapabilities(["network"], ["network"]);
    expect(result.malformed).toEqual(["network"]);
    expect([...result.grants.declared]).toEqual([]);
  });
});

describe("no widening", () => {
  /**
   * These two are the whole reason prefix widening was left out: each would pass
   * under a `startsWith` check and each is a privilege escalation.
   */
  test("a namespace grant does not imply a qualified capability", () => {
    const { grants } = authorizeCapabilities(["network:https", "network:https:api.example.com"], ["network:https"]);
    const decision = checkCapability(grants, "network:https:api.example.com");
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe("CAPABILITY_NOT_GRANTED");
  });

  test("a scoped secrets grant does not imply an unscoped one", () => {
    const { grants } = authorizeCapabilities(["secrets:read:scoped", "secrets:read"], ["secrets:read:scoped"]);
    expect(checkCapability(grants, "secrets:read").granted).toBe(false);
  });

  test("there is no wildcard", () => {
    const result = authorizeCapabilities(["network:*"], ["network:*"]);
    expect(result.malformed).toEqual(["network:*"]);
  });
});
