import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionDefinition, LoadedModel } from "@aoe/model-schema";
import { PolicyEngine, PolicySetSchema, loadPolicySets, selectPolicySet, validatePolicySet, type PolicySet } from "../src/index.ts";

const root = join(import.meta.dir, `.tmp-policy-${process.pid}`);
const outside = join(root, "outside");
const sets = join(root, "policies");

/**
 * Deliberately generic names. A fixture that used a real domain's action or role
 * names would make the tests pass for the wrong reason: the engine would look
 * correct while the names it compared happened to be ones it could have known.
 */
const action = (over: Partial<ActionDefinition> = {}): ActionDefinition => ({ kind: "action", name: "ActionA", version: "1.0.0", inputs: [], output: "string", capabilities: ["cap.a"], sideEffects: "none", idempotency: "idempotent", approval: "conditional", ...over });

const context = (over: Partial<Parameters<PolicyEngine["explain"]>[1]> = {}) => ({ principal: "p-1", roles: ["role-a"], allowedCapabilities: ["cap.a"], tenant: "t-1", workspace: "w-1", ...over });

const set = (body: Record<string, unknown>): PolicySet => PolicySetSchema.parse({ protocol: "prime/policy/v1", name: "set-a", version: "1.0.0", ...body });

beforeAll(() => { mkdirSync(sets, { recursive: true }); mkdirSync(outside, { recursive: true }); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("policy set schema", () => {
  test("a set that does not declare what happens to an unmatched request fails to parse", () => {
    const result = PolicySetSchema.safeParse({ protocol: "prime/policy/v1", name: "set-a", version: "1.0.0", rules: [] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("default");
  });

  test("an axis constrained to nothing is rejected, so it cannot masquerade as an unconstrained axis", () => {
    expect(PolicySetSchema.safeParse({ protocol: "prime/policy/v1", name: "set-a", version: "1.0.0", default: "deny", rules: [{ id: "r", effect: "allow", match: { actions: [] } }] }).success).toBe(false);
  });

  test("the governance axes accept exactly the protocol's values, because they are read off ActionDefinitionSchema rather than re-listed", () => {
    expect(PolicySetSchema.safeParse({ protocol: "prime/policy/v1", name: "s", version: "1.0.0", default: "deny", rules: [{ id: "r", effect: "allow", match: { sideEffects: ["write"], idempotency: ["unknown"], approval: ["conditional"] } }] }).success).toBe(true);
    expect(PolicySetSchema.safeParse({ protocol: "prime/policy/v1", name: "s", version: "1.0.0", default: "deny", rules: [{ id: "r", effect: "allow", match: { sideEffects: ["external"] } }] }).success).toBe(false);
    expect(PolicySetSchema.safeParse({ protocol: "prime/policy/v1", name: "s", version: "1.0.0", default: "deny", rules: [{ id: "r", effect: "allow", match: { approval: ["none"] } }] }).success).toBe(false);
  });

  test("an unknown protocol or an unknown match axis is refused", () => {
    expect(PolicySetSchema.safeParse({ protocol: "prime/policy/v2", name: "s", version: "1.0.0", default: "deny" }).success).toBe(false);
    expect(PolicySetSchema.safeParse({ protocol: "prime/policy/v1", name: "s", version: "1.0.0", default: "deny", rules: [{ id: "r", effect: "allow", match: { inputContains: ["x"] } }] }).success).toBe(false);
  });
});

describe("decision", () => {
  test("an unmatched request falls to the set's declared default, and the default is reported", async () => {
    const denying = new PolicyEngine(set({ default: "deny", rules: [{ id: "other", effect: "allow", match: { actions: ["ActionB"] } }] }));
    const denied = await denying.decide(action(), {}, context());
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("declared default is deny");
    expect(denied.evidence).toEqual(expect.arrayContaining([{ kind: "policy-default", value: "deny" }]));

    const allowing = new PolicyEngine(set({ default: "allow", rules: [] }));
    expect((await allowing.decide(action(), {}, context())).allowed).toBe(true);
  });

  test("an approval: conditional action is allowed when a declared rule matches its axes", async () => {
    const engine = new PolicyEngine(set({ default: "deny", rules: [{ id: "conditional-with-role-and-capability", effect: "allow", description: "declared by the set, not by the engine", match: { approval: ["conditional"], sideEffects: ["none"], anyRole: ["role-a"], allCapabilities: ["cap.a"], requiresDeclaredCapabilities: true, tenants: ["t-1"], workspaces: ["w-1"] } }] }));
    const decision = await engine.decide(action(), {}, context());
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("conditional-with-role-and-capability");
    expect(decision.evidence).toEqual(expect.arrayContaining([
      { kind: "policy-set", value: "set-a@1.0.0" },
      { kind: "policy-rule", value: "conditional-with-role-and-capability" },
      { kind: "policy-match:approval", value: "conditional" },
      { kind: "policy-match:requiresDeclaredCapabilities", value: "cap.a" },
    ]));
  });

  test("the same rule denies the same action once one axis stops holding", async () => {
    const engine = new PolicyEngine(set({ default: "deny", rules: [{ id: "needs-role-a", effect: "allow", match: { anyRole: ["role-a"] } }] }));
    expect((await engine.decide(action(), {}, context({ roles: ["role-b"] }))).allowed).toBe(false);
    expect((await engine.decide(action(), {}, context({ roles: ["role-a"] }))).allowed).toBe(true);
  });

  test("requiresDeclaredCapabilities compares the action's own declaration, so it needs no capability name in the set", async () => {
    const engine = new PolicyEngine(set({ default: "deny", rules: [{ id: "holds-what-the-action-declares", effect: "allow", match: { requiresDeclaredCapabilities: true } }] }));
    expect((await engine.decide(action({ capabilities: ["cap.x", "cap.y"] }), {}, context({ allowedCapabilities: ["cap.x", "cap.y"] }))).allowed).toBe(true);
    expect((await engine.decide(action({ capabilities: ["cap.x", "cap.y"] }), {}, context({ allowedCapabilities: ["cap.x"] }))).allowed).toBe(false);
  });

  test("a matching deny outranks a matching allow whichever order they are declared in", async () => {
    const allowFirst = new PolicyEngine(set({ default: "allow", rules: [{ id: "a", effect: "allow", match: {} }, { id: "d", effect: "deny", match: { sideEffects: ["none"] } }] }));
    const denyFirst = new PolicyEngine(set({ default: "allow", rules: [{ id: "d", effect: "deny", match: { sideEffects: ["none"] } }, { id: "a", effect: "allow", match: {} }] }));
    for (const engine of [allowFirst, denyFirst]) {
      const decision = await engine.decide(action(), {}, context());
      expect(decision.allowed).toBe(false);
      expect(decision.evidence).toEqual(expect.arrayContaining([{ kind: "policy-rule", value: "d" }]));
    }
  });

  test("a request claiming a different policy set is refused rather than governed by the loaded one", async () => {
    const engine = new PolicyEngine(set({ default: "allow", rules: [] }));
    const decision = await engine.decide(action(), {}, context({ policyRef: "set-b" }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Policy set mismatch");
    expect((await engine.decide(action(), {}, context({ policyRef: "set-a" }))).allowed).toBe(true);
  });

  test("a request that names no policy set is evaluated with the unbound claim on the record", async () => {
    const engine = new PolicyEngine(set({ default: "allow", rules: [] }));
    expect((await engine.decide(action(), {}, context())).evidence).toEqual(expect.arrayContaining([{ kind: "policy-ref-unbound", value: "set-a" }]));
  });

  test("the untenanted case is matched by declaring it, not by absence meaning any", async () => {
    const engine = new PolicyEngine(set({ default: "deny", rules: [{ id: "untenanted", effect: "allow", match: { tenants: [""] } }] }));
    expect((await engine.decide(action(), {}, { principal: "p", roles: [], allowedCapabilities: [] })).allowed).toBe(true);
    expect((await engine.decide(action(), {}, context({ tenant: "t-1" }))).allowed).toBe(false);
  });

  test("explain() reports every rule and every axis, matched or not", () => {
    const engine = new PolicyEngine(set({ default: "deny", rules: [{ id: "r1", effect: "allow", match: { actions: ["ActionB"], anyRole: ["role-a"] } }] }));
    const explanation = engine.explain(action(), context());
    expect(explanation.evaluations).toHaveLength(1);
    expect(explanation.evaluations[0]!.matched).toBe(false);
    expect(explanation.evaluations[0]!.axes).toEqual([{ axis: "actions", matched: false, value: "ActionA" }, { axis: "anyRole", matched: true, value: "role-a" }]);
  });
});

describe("loading", () => {
  test("a directory with one valid set loads, and selectPolicySet resolves it by name", () => {
    writeFileSync(join(sets, "a.yaml"), "protocol: prime/policy/v1\nname: set-a\nversion: 1.0.0\ndefault: deny\nrules:\n  - id: r1\n    effect: allow\n    match:\n      approval: [conditional]\n");
    const result = loadPolicySets(sets);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(one => one.name)).toEqual(["set-a"]);
    expect(selectPolicySet(result.value, "set-a")?.name).toBe("set-a");
    expect(selectPolicySet(result.value, "set-missing")).toBeUndefined();
    expect(selectPolicySet(result.value, "")?.name).toBe("set-a");
    expect(selectPolicySet([...result.value, { ...result.value[0]!, name: "set-b" }], "")).toBeUndefined();
  });

  test("a missing directory and an empty directory are both reported, not treated as an empty allow-list", () => {
    const missing = loadPolicySets(join(root, "absent"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics[0]!.code).toBe("POLICY_ROOT_INVALID");
    const emptyDir = join(root, "empty");
    mkdirSync(emptyDir, { recursive: true });
    const empty = loadPolicySets(emptyDir);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.diagnostics[0]!.code).toBe("POLICY_SET_NOT_FOUND");
  });

  test("a document that resolves outside the policy root is refused", () => {
    const escaping = join(root, "escaping");
    mkdirSync(escaping, { recursive: true });
    writeFileSync(join(outside, "elsewhere.yaml"), "protocol: prime/policy/v1\nname: set-x\nversion: 1.0.0\ndefault: allow\n");
    symlinkSync(join(outside, "elsewhere.yaml"), join(escaping, "link.yaml"));
    const result = loadPolicySets(escaping);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map(one => one.code)).toContain("PATH_OUTSIDE_ROOT");
  });

  test("a malformed document, a duplicate rule id and a duplicate set name are each reported", () => {
    const bad = join(root, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "a.yaml"), "protocol: prime/policy/v1\nname: set-a\nversion: 1.0.0\ndefault: deny\nrules:\n  - id: r\n    effect: allow\n  - id: r\n    effect: deny\n");
    writeFileSync(join(bad, "b.yaml"), "protocol: prime/policy/v1\nname: set-a\nversion: 1.0.0\ndefault: deny\n");
    writeFileSync(join(bad, "c.yaml"), ": : :\n");
    const result = loadPolicySets(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map(one => one.code).sort()).toEqual(["DUPLICATE_POLICY_RULE", "DUPLICATE_POLICY_SET", "YAML_PARSE_ERROR"]);
  });
});

describe("references into the model", () => {
  const model = (definitions: LoadedModel["definitions"]): LoadedModel => ({ root: "/nowhere", manifest: { protocol: "prime/model/v2", name: "m", version: "1.0.0", files: ["d.yaml"] }, definitions });

  test("a rule pinned to an action or capability the model does not have is reported, because such a rule never fires", () => {
    const diagnostics = validatePolicySet(set({ default: "deny", rules: [{ id: "r", effect: "allow", match: { actions: ["ActionMissing"], allCapabilities: ["cap.missing"] } }] }), model([action()]));
    expect(diagnostics.map(one => one.code).sort()).toEqual(["DANGLING_ACTION_REF", "DANGLING_CAPABILITY_REF"]);
  });

  test("a rule whose references all exist reports nothing", () => {
    expect(validatePolicySet(set({ default: "deny", rules: [{ id: "r", effect: "allow", match: { actions: ["ActionA"], allCapabilities: ["cap.a"] } }] }), model([action()]))).toEqual([]);
  });
});
