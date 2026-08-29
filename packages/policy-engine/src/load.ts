import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Diagnostic } from "@skill-wiki/model-schema";
import { parse } from "yaml";
import { PolicySetSchema, type PolicySet } from "./schema.ts";

export type PolicyLoadResult = { readonly ok: true; readonly value: readonly PolicySet[] } | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export class PolicyLoadError extends Error { constructor(readonly diagnostics: readonly Diagnostic[]) { super("Invalid policy set"); } }

const diag = (code: string, message: string, path?: string, definition?: string): Diagnostic => ({ code, message, path, definition });

/** The default directory name a model package keeps its policy sets under. Not a domain word: it is this protocol's own directory, the way `prime-model.yaml` is the model protocol's own file name. */
export const POLICY_DIRECTORY = "policies";

/**
 * §12.3's path rules, applied to the policy set the way `model-schema` applies
 * them to a definition file. A policy set is the one document that decides
 * whether a side effect may happen, so a set loaded from outside the root it was
 * supposed to come from is worse than no set at all: it looks authoritative.
 */
function safeFile(rootReal: string, root: string, file: string, diagnostics: Diagnostic[]): string | undefined {
  if (file.includes("\0")) { diagnostics.push(diag("PATH_INVALID", "Policy path must not contain NUL", file)); return; }
  if (isAbsolute(file) || file.split(/[\\/]+/).includes("..")) { diagnostics.push(diag("PATH_OUTSIDE_ROOT", "Policy path must be a relative path within the policy root", file)); return; }
  const candidate = resolve(root, file);
  if (!existsSync(candidate) || lstatSync(candidate).isDirectory()) { diagnostics.push(diag("POLICY_FILE_INVALID", "Policy path must name an existing regular file", file)); return; }
  const actual = realpathSync(candidate);
  const rel = relative(rootReal, actual);
  if (rel.startsWith("..") || isAbsolute(rel)) { diagnostics.push(diag("PATH_OUTSIDE_ROOT", "Policy path resolves outside the policy root", file)); return; }
  if (!lstatSync(actual).isFile()) { diagnostics.push(diag("POLICY_FILE_INVALID", "Policy path must resolve to a regular file", file)); return; }
  return actual;
}

function parseOne(path: string, label: string, diagnostics: Diagnostic[]): PolicySet | undefined {
  let document: unknown;
  try { document = parse(readFileSync(path, "utf8")); }
  catch (error) { diagnostics.push(diag("YAML_PARSE_ERROR", error instanceof Error ? error.message : "YAML parsing failed", label)); return; }
  const result = PolicySetSchema.safeParse(document);
  if (!result.success) { diagnostics.push(diag("INVALID_POLICY_SET", result.error.issues.map(issue => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "), label)); return; }
  const ids = new Set<string>();
  for (const rule of result.data.rules) {
    if (ids.has(rule.id)) diagnostics.push(diag("DUPLICATE_POLICY_RULE", "Duplicate policy rule id", label, rule.id));
    ids.add(rule.id);
  }
  return result.data;
}

/**
 * Loads every policy set in a directory. Sorted by file name and rejecting
 * duplicate set names, because a decision has to be reproducible: two sets with
 * one name would make "which policy allowed this" unanswerable after the fact.
 */
export function loadPolicySets(directory: string): PolicyLoadResult {
  const diagnostics: Diagnostic[] = [];
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return { ok: false, diagnostics: [diag("POLICY_ROOT_INVALID", "Policy root must be an existing directory", directory)] };
  const rootReal = realpathSync(directory);
  const files = readdirSync(rootReal, { withFileTypes: true }).filter(entry => !entry.isDirectory() && /\.ya?ml$/.test(entry.name)).map(entry => entry.name).sort();
  if (files.length === 0) return { ok: false, diagnostics: [diag("POLICY_SET_NOT_FOUND", "Policy root contains no policy set document", directory)] };
  const sets: PolicySet[] = [];
  const names = new Set<string>();
  for (const file of files) {
    const path = safeFile(rootReal, rootReal, file, diagnostics);
    if (!path) continue;
    const set = parseOne(path, file, diagnostics);
    if (!set) continue;
    if (names.has(set.name)) { diagnostics.push(diag("DUPLICATE_POLICY_SET", "Duplicate policy set name", file, set.name)); continue; }
    names.add(set.name);
    sets.push(set);
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value: sets };
}

/**
 * A model package's policy sets live beside its manifest rather than inside it.
 * That is forced, not chosen: `ModelManifestSchema` is `.strict()` with a `files`
 * list of definition documents, and `DefinitionSchema` is a discriminated union
 * with no policy member — so a policy set cannot be declared by the manifest
 * without changing the model protocol. The consequence is recorded in this lane's
 * report: the model digest does not currently cover the policy set, which §8.5
 * expects a snapshot to bind.
 */
export function loadModelPolicySets(modelRoot: string): PolicyLoadResult { return loadPolicySets(join(modelRoot, POLICY_DIRECTORY)); }

export function loadPolicySetsOrThrow(directory: string): readonly PolicySet[] {
  const result = loadPolicySets(directory);
  if (!result.ok) throw new PolicyLoadError(result.diagnostics);
  return result.value;
}

/**
 * `policyRef` is the request's claim about which set governs it (§8.5). Resolving
 * it here rather than in the engine keeps the engine unable to silently fall back
 * to some other set when the named one is absent.
 */
export function selectPolicySet(sets: readonly PolicySet[], policyRef: string | undefined): PolicySet | undefined {
  if (policyRef === undefined || policyRef === "") return sets.length === 1 ? sets[0] : undefined;
  return sets.find(set => set.name === policyRef);
}
