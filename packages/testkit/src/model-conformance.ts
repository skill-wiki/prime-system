import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadModel, type ActionDefinition, type FunctionDefinition, type LoadedModel, type ModelDefinition, type ProjectionDefinition, type RelationDefinition, type RetrievalProfile, type TypeDefinition } from "@skill-wiki/model-schema";
import { assertSchemaDigestSelfConsistent, generateSdk } from "@skill-wiki/sdk-codegen";
import { defaultRendererSections, type RendererSections } from "./renderer-sections.ts";
import { check, finding, formatReport, report, skipped, type CheckOutcome, type Finding, type SuiteReport } from "./diagnostics.ts";

/** §17.1 Protocol Conformance. Nothing here knows a single domain type name. */

const MANIFEST_CODES = new Set([
  "MODEL_ROOT_INVALID", "MANIFEST_NOT_FOUND", "INVALID_MANIFEST", "YAML_PARSE_ERROR",
  "PATH_OUTSIDE_ROOT", "DEFINITION_FILE_INVALID", "DUPLICATE_FILE_PATH", "INVALID_DEFINITION_FILE",
]);

function byKind<K extends ModelDefinition["kind"]>(model: LoadedModel, kind: K): readonly Extract<ModelDefinition, { kind: K }>[] {
  return model.definitions.filter((d): d is Extract<ModelDefinition, { kind: K }> => d.kind === kind);
}

function manifestCheck(diagnostics: readonly { code: string; message: string; path?: string; definition?: string }[]): CheckOutcome {
  const hits = diagnostics.filter(d => MANIFEST_CODES.has(d.code));
  return check("MC-MANIFEST", "Manifest and definition-file schema validation",
    hits.map(d => finding(d.code, d.message, "error", { path: d.path, subject: d.definition })));
}

function refCheck(diagnostics: readonly { code: string; message: string; path?: string; definition?: string }[]): CheckOutcome {
  const hits = diagnostics.filter(d => !MANIFEST_CODES.has(d.code));
  return check("MC-REFS", "Type / relation / projection reference resolution",
    hits.map(d => finding(d.code, d.message, "error", { path: d.path, subject: d.definition })));
}

/**
 * Relation semantics legality is checked for internal contradiction only.
 * Whether `requires` should be transitive is a model's decision; whether a
 * relation can be a *closure* while declaring *no* traversal is not — that
 * combination gives the engine two incompatible instructions.
 */
function relationSemanticsCheck(relations: readonly RelationDefinition[]): CheckOutcome {
  const findings: Finding[] = [];
  const index = new Map(relations.map(r => [r.name, r]));
  for (const r of relations) {
    const s = r.semantics;
    const at = { subject: `relation:${r.name}` };
    if (s.selection === "closure" && s.traversal !== "transitive")
      findings.push(finding("RELATION_CLOSURE_WITHOUT_TRANSITIVE", `selection=closure requires traversal=transitive, got traversal=${s.traversal}`, "error", at));
    if (s.selection === "expand" && s.traversal === "none")
      findings.push(finding("RELATION_EXPAND_WITHOUT_TRAVERSAL", "selection=expand cannot be satisfied with traversal=none", "error", at));
    if (s.cyclePolicy !== "allow" && s.traversal === "none")
      findings.push(finding("RELATION_CYCLE_POLICY_UNREACHABLE", `cyclePolicy=${s.cyclePolicy} is unreachable with traversal=none`, "warning", at));
    if (s.conflictSeverity === "error" && s.selection === "informational")
      findings.push(finding("RELATION_CONFLICT_NOT_ENFORCED", "conflictSeverity=error but selection=informational: a fatal conflict that never affects selection", "warning", at));
    if (s.loadOrder !== "none" && s.traversal === "none")
      findings.push(finding("RELATION_LOAD_ORDER_UNREACHABLE", `loadOrder=${s.loadOrder} is unreachable with traversal=none`, "warning", at));
    if (r.inverse !== undefined) {
      if (!r.directional)
        findings.push(finding("RELATION_INVERSE_ON_UNDIRECTED", "a non-directional relation is its own inverse; declaring `inverse` is contradictory", "warning", at));
      const other = index.get(r.inverse);
      if (other && other.inverse !== undefined && other.inverse !== r.name)
        findings.push(finding("RELATION_INVERSE_ASYMMETRIC", `inverse=${r.inverse} but ${r.inverse}.inverse=${other.inverse}`, "error", at));
      if (other && (other.from !== r.to || other.to !== r.from))
        findings.push(finding("RELATION_INVERSE_ENDPOINTS_MISMATCH", `inverse endpoints must be swapped: ${r.from}->${r.to} vs ${other.from}->${other.to}`, "error", at));
    }
  }
  return check("MC-RELATION-SEMANTICS", "Relation semantics internal consistency", findings);
}

function ioCheck(functions: readonly FunctionDefinition[], actions: readonly ActionDefinition[]): CheckOutcome {
  const findings: Finding[] = [];
  const duplicateInputs = (inputs: readonly { name: string }[], subject: string) => {
    const seen = new Set<string>();
    for (const i of inputs) {
      if (seen.has(i.name)) findings.push(finding("DUPLICATE_INPUT_NAME", `duplicate input name: ${i.name}`, "error", { subject }));
      seen.add(i.name);
    }
  };
  for (const f of functions) {
    const subject = `function:${f.name}`;
    duplicateInputs(f.inputs, subject);
    if (f.purity === "pure" && !f.deterministic)
      findings.push(finding("FUNCTION_PURE_NONDETERMINISTIC", "purity=pure requires deterministic=true", "error", { subject }));
  }
  for (const a of actions) {
    const subject = `action:${a.name}`;
    duplicateInputs(a.inputs, subject);
    // §12.3: an unauthorized capability must not be able to execute. A writing
    // action that declares no capability is by construction ungoverned.
    if (a.sideEffects === "write" && a.capabilities.length === 0)
      findings.push(finding("ACTION_WRITE_WITHOUT_CAPABILITY", "sideEffects=write requires at least one declared capability", "error", { subject }));
    if (a.sideEffects === "write" && a.idempotency === "unknown")
      findings.push(finding("ACTION_WRITE_IDEMPOTENCY_UNKNOWN", "sideEffects=write with idempotency=unknown cannot be safely retried", "warning", { subject }));
    if (a.sideEffects === "none" && a.approval === "always")
      findings.push(finding("ACTION_APPROVAL_WITHOUT_EFFECT", "approval=always on a side-effect-free action", "warning", { subject }));
    if (a.sideEffects !== "none" && a.provider === undefined)
      findings.push(finding("ACTION_EFFECT_WITHOUT_PROVIDER", `sideEffects=${a.sideEffects} requires a provider`, "error", { subject }));
  }
  return check("MC-ACTION-IO", "Function / action input and output declarations", findings);
}

const WILDCARD = "*";

/**
 * Attributes every unit carries on `UnitIR.identity` / `UnitIR.typeRef` rather
 * than in `fields` (see `packages/ir/src/index.ts`). A projection selecting one
 * is always satisfiable, so grading it as a missing field declaration would be
 * wrong regardless of the model. Protocol-level, not domain-level.
 */
const IDENTITY_ATTRIBUTES: ReadonlySet<string> = new Set(["id", "version", "kind", "digest", "corpus", "lifecycle", "visibility"]);

/** Where a selector came from: an explicit rule, or the projection-wide `include`. */
type SelectorOrigin = "rule" | "base";

interface Coverage {
  /** typeName -> selector -> strongest origin that asked for it. */
  readonly selectorsByType: Map<string, Map<string, SelectorOrigin>>;
  readonly wildcardTypes: Set<string>;
}

function coverageOf(projections: readonly ProjectionDefinition[], typeNames: readonly string[]): Coverage {
  const selectorsByType = new Map<string, Map<string, SelectorOrigin>>();
  const wildcardTypes = new Set<string>();
  const add = (type: string, selectors: readonly string[], origin: SelectorOrigin) => {
    const bucket = selectorsByType.get(type) ?? new Map<string, SelectorOrigin>();
    for (const s of selectors) {
      if (s === WILDCARD) wildcardTypes.add(type);
      else if (bucket.get(s) !== "rule") bucket.set(s, origin);
    }
    selectorsByType.set(type, bucket);
  };
  for (const p of projections) {
    const resolveTarget = (typeRef?: string): readonly string[] => {
      if (typeRef === undefined) return typeNames; // no typeRef == applies to every type
      if (typeRef.startsWith("group:")) return p.typeGroups[typeRef.slice("group:".length)] ?? [];
      if (typeRef === WILDCARD) return typeNames;
      return [typeRef];
    };
    // Top-level include/exclude applies model-wide, so it covers every type.
    if (p.include.length > 0) for (const t of typeNames) add(t, p.include, "base");
    for (const rule of p.rules) for (const t of resolveTarget(rule.typeRef)) add(t, rule.include ?? [], rule.typeRef === undefined ? "base" : "rule");
  }
  return { selectorsByType, wildcardTypes };
}

/**
 * Projection completeness has two halves, and only reporting the first is how a
 * model of empty type shells passes a "complete" projection audit: a rule can
 * name a type and still project nothing, because the type declares no field the
 * selector could resolve against.
 */
function projectionCheck(
  types: readonly TypeDefinition[],
  projections: readonly ProjectionDefinition[],
  renderer: RendererSections,
): readonly CheckOutcome[] {
  if (projections.length === 0)
    return [check("MC-PROJ-COVERAGE", "Every type is covered by a projection rule", [finding("NO_PROJECTIONS", "model declares no projection", "error")])];

  const typeNames = types.map(t => t.name);
  const { selectorsByType, wildcardTypes } = coverageOf(projections, typeNames);
  const coverageFindings: Finding[] = [];
  for (const t of types) {
    const covered = wildcardTypes.has(t.name) || (selectorsByType.get(t.name)?.size ?? 0) > 0;
    if (!covered) coverageFindings.push(finding("TYPE_NOT_PROJECTED", "no projection rule covers this type", "error", { subject: `type:${t.name}` }));
  }

  const selectorFindings: Finding[] = [];
  const sectionFindings: Finding[] = [];
  for (const t of types) {
    const wanted = selectorsByType.get(t.name);
    if (!wanted || wanted.size === 0) continue;
    const declared = new Set(t.fields.map(f => f.name));
    if (declared.size === 0) {
      selectorFindings.push(finding(
        "PROJECTION_TARGET_HAS_NO_FIELDS",
        `projection selects ${wanted.size} field(s) from a type that declares none (${[...wanted.keys()].sort().slice(0, 6).join(", ")}${wanted.size > 6 ? ", …" : ""}); completeness is unverifiable`,
        "error", { subject: `type:${t.name}` }));
      continue;
    }
    const missing = [...wanted].filter(([s]) => !declared.has(s));
    // Two namespaces, split before grading: a renderer section name is not a
    // failed field selector, it is a different axis the protocol cannot yet spell.
    const identity = missing.filter(([s]) => IDENTITY_ATTRIBUTES.has(s)).map(([s]) => s).sort();
    const sections = missing.filter(([s]) => !IDENTITY_ATTRIBUTES.has(s) && renderer.names.has(s)).map(([s]) => s).sort();
    const unresolved = missing.filter(([s]) => !IDENTITY_ATTRIBUTES.has(s) && !renderer.names.has(s));
    if (identity.length > 0)
      selectorFindings.push(finding(
        "PROJECTION_SELECTOR_IS_IDENTITY_ATTRIBUTE",
        `selector(s) name a unit identity attribute rather than a type field: ${identity.join(", ")}. Always satisfiable; reported for completeness only.`,
        "info", { subject: `type:${t.name}` }));
    const byRule = unresolved.filter(([, origin]) => origin === "rule").map(([s]) => s).sort();
    const byBase = unresolved.filter(([, origin]) => origin === "base").map(([s]) => s).sort();
    if (byRule.length > 0)
      selectorFindings.push(finding(
        "PROJECTION_SELECTOR_UNRESOLVED",
        `a projection rule naming this type selects undeclared field(s): ${byRule.join(", ")}`,
        t.additionalFields === "unknown" ? "warning" : "error", { subject: `type:${t.name}` }));
    // A projection-wide `include` is not a claim about any single type, so an
    // unresolved base selector is reported without gating.
    if (byBase.length > 0)
      selectorFindings.push(finding(
        "PROJECTION_BASE_SELECTOR_UNRESOLVED",
        `projection-wide include names field(s) this type does not declare: ${byBase.join(", ")}`,
        "warning", { subject: `type:${t.name}` }));
    if (sections.length > 0)
      sectionFindings.push(finding(
        "PROJECTION_SELECTOR_IS_RENDERER_SECTION",
        `${sections.length} selector(s) match a renderer section name rather than a declared field (${sections.join(", ")}). `
        + `These dispatch to an appender that no-ops when the field is absent, so they are a rendering menu, not a field declaration. `
        + `The protocol cannot currently distinguish the two namespaces, so this is reported, not graded.`,
        "warning", { subject: `type:${t.name}` }));
  }

  return [
    check("MC-PROJ-COVERAGE", "Every type is covered by a projection rule", coverageFindings),
    check("MC-PROJ-SELECTORS", "Every projection selector resolves to a declared field", selectorFindings),
    check("MC-PROJ-RENDERER-SECTIONS", `Selectors that name a renderer section instead of a field (vocabulary: ${renderer.name})`, sectionFindings),
  ];
}

/**
 * A type whose only statement is `additionalFields: unknown` validates nothing.
 * Accepting it means the "external model" is a name list, not a schema.
 */
function typeSubstanceCheck(types: readonly TypeDefinition[]): CheckOutcome {
  const findings: Finding[] = [];
  if (types.length === 0) findings.push(finding("NO_TYPES", "model declares no type", "error"));
  for (const t of types) {
    if (t.fields.length === 0)
      findings.push(finding("TYPE_DECLARES_NO_FIELDS", `type declares no field (additionalFields=${t.additionalFields}); instance validation is a no-op`, "error", { subject: `type:${t.name}` }));
    const seen = new Set<string>();
    for (const f of t.fields) {
      if (seen.has(f.name)) findings.push(finding("DUPLICATE_FIELD_NAME", `duplicate field: ${f.name}`, "error", { subject: `type:${t.name}` }));
      seen.add(f.name);
    }
  }
  return check("MC-TYPE-SUBSTANCE", "Types declare a real field schema", findings);
}

function retrievalCheck(profiles: readonly RetrievalProfile[]): CheckOutcome {
  const findings: Finding[] = [];
  for (const p of profiles) {
    const subject = `retrieval-profile:${p.name}`;
    const names = new Set<string>();
    for (const g of p.candidateGenerators) {
      if (names.has(g.name)) findings.push(finding("DUPLICATE_GENERATOR", `duplicate candidate generator: ${g.name}`, "error", { subject }));
      names.add(g.name);
    }
    if (p.candidateGenerators.every(g => g.weight === 0))
      findings.push(finding("GENERATOR_WEIGHTS_ALL_ZERO", "every candidate generator has weight 0: the profile can never retrieve", "error", { subject }));
    if (Object.keys(p.features).length === 0)
      findings.push(finding("PROFILE_WITHOUT_FEATURES", "profile declares no feature weight", "warning", { subject }));
  }
  return check("MC-RETRIEVAL-PROFILE", "Retrieval profiles are executable", findings);
}

export interface ModelConformanceOptions {
  /**
   * Types with an empty field schema are an error by default. A model may opt
   * out while it is being filled in, but the opt-out is recorded in the report
   * rather than hidden.
   */
  readonly allowEmptyTypeShells?: boolean;
  /**
   * The renderer-section namespace, so a section name is not misreported as a
   * failed field selector (see `renderer-sections.ts`). Defaults to the bundled
   * chunker vocabulary.
   */
  readonly rendererSections?: RendererSections;
}

/**
 * §17.1 MC-SDK-COMPILE. The acceptance is that the *emitted bytes* compile, so
 * this shells out to the repo's own `tsc` rather than trusting that the templates
 * look right: a generator can emit a missing import, a property name that needs
 * quoting, or a type referenced before it is declared, and only a compiler finds
 * those.
 *
 * The scratch directory has to live inside this package rather than under
 * `os.tmpdir()`, because the generated `types.ts` and `client.ts` both import
 * `@skill-wiki/sdk`, and module resolution has to be able to walk up from the
 * artifacts to `packages/testkit/node_modules`.
 */
function sdkCompileCheck(model: LoadedModel): CheckOutcome {
  const id = "MC-SDK-COMPILE";
  const title = "Generated SDK compiles";
  const repo = resolve(import.meta.dir, "..", "..", "..");
  const testkit = resolve(import.meta.dir, "..");
  const findings: Finding[] = [];

  let generated: ReturnType<typeof generateSdk>;
  try {
    generated = generateSdk(model);
  } catch (e) {
    return check(id, title, [finding("SDK_GENERATION_FAILED", `generateSdk threw: ${e instanceof Error ? e.message : String(e)}`, "error")]);
  }

  // The emitted `schema.json` claims the digest its siblings were generated from.
  // If it does not hash to that digest, the artifacts compiling proves nothing.
  try {
    assertSchemaDigestSelfConsistent(generated.schema.schema);
  } catch (e) {
    findings.push(finding("SDK_SCHEMA_DIGEST_INCONSISTENT", e instanceof Error ? e.message : String(e), "error"));
  }

  let scratch: string | undefined;
  let unavailable: string | undefined;
  try {
    scratch = mkdtempSync(join(testkit, ".mc-sdk-compile-"));
    for (const file of generated.files) writeFileSync(join(scratch, file.path), file.content, "utf8");
    const tsconfig = join(scratch, "tsconfig.json");
    writeFileSync(tsconfig, JSON.stringify({
      extends: join(repo, "tsconfig.json"),
      compilerOptions: { noEmit: true },
      include: ["*.ts"],
    }), "utf8");

    let result: { exitCode: number | null; stdout: Buffer; stderr: Buffer };
    try {
      result = Bun.spawnSync(["npx", "tsc", "--noEmit", "-p", tsconfig], { cwd: repo });
    } catch (e) {
      // No compiler on this machine is not a statement about the model, so it is
      // a skip rather than a failure (§17.5 forbids the reverse, not this).
      unavailable = `could not run \`npx tsc\`: ${e instanceof Error ? e.message : String(e)}`;
      result = { exitCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }

    if (unavailable === undefined) {
      const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
      if (result.exitCode !== 0 || output.length > 0) {
        for (const line of output.split("\n").filter(l => l.trim().length > 0)) {
          findings.push(finding("SDK_DOES_NOT_COMPILE", line.trim(), "error", { subject: `sdk:${generated.modelDigest}` }));
        }
        if (findings.length === 0) {
          findings.push(finding("SDK_DOES_NOT_COMPILE", `tsc exited ${result.exitCode} with no diagnostics`, "error"));
        }
      }
    }
  } catch (e) {
    findings.push(finding("SDK_COMPILE_CHECK_ERROR", e instanceof Error ? e.message : String(e), "error"));
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }

  if (unavailable !== undefined && findings.length === 0) return skipped(id, title, unavailable);
  return check(id, title, findings);
}

export function runModelConformance(root: string, options: ModelConformanceOptions = {}): SuiteReport {
  const loaded = loadModel(root);
  const diagnostics = loaded.ok ? [] : loaded.diagnostics;
  const checks: CheckOutcome[] = [manifestCheck(diagnostics), refCheck(diagnostics)];

  if (!loaded.ok) {
    for (const [id, title] of [
      ["MC-TYPE-SUBSTANCE", "Types declare a real field schema"],
      ["MC-RELATION-SEMANTICS", "Relation semantics internal consistency"],
      ["MC-ACTION-IO", "Function / action input and output declarations"],
      ["MC-PROJ-COVERAGE", "Every type is covered by a projection rule"],
      ["MC-PROJ-SELECTORS", "Every projection selector resolves to a declared field"],
      ["MC-PROJ-RENDERER-SECTIONS", "Selectors that name a renderer section instead of a field"],
      ["MC-RETRIEVAL-PROFILE", "Retrieval profiles are executable"],
      ["MC-SDK-COMPILE", "Generated SDK compiles"],
    ] as const) checks.push(skipped(id, title, "model did not load; definitions unavailable"));
  } else {
    const model = loaded.value;
    const types = byKind(model, "type");
    const substance = typeSubstanceCheck(types);
    checks.push(options.allowEmptyTypeShells === true
      ? { ...substance, findings: substance.findings.map(f => f.code === "TYPE_DECLARES_NO_FIELDS" ? { ...f, severity: "warning" as const } : f), status: substance.findings.some(f => f.severity === "error" && f.code !== "TYPE_DECLARES_NO_FIELDS") ? "fail" : "pass" }
      : substance);
    checks.push(relationSemanticsCheck(byKind(model, "relation")));
    checks.push(ioCheck(byKind(model, "function"), byKind(model, "action")));
    checks.push(...projectionCheck(types, byKind(model, "projection"), options.rendererSections ?? defaultRendererSections()));
    checks.push(retrievalCheck(byKind(model, "retrieval-profile")));
    checks.push(sdkCompileCheck(model));
  }

  // §17.1 lists both, and §17.5 forbids dressing a skip up as a pass.
  checks.push(skipped("MC-MIGRATION-ROUNDTRIP", "Migration roundtrip", "protocol has no migration definition kind yet (plan §13.3)"));

  return report("model-conformance", root, checks);
}

export { formatReport };
