#!/usr/bin/env bun
/**
 * scripts/derive-compat-model.ts
 *
 * Derive `compat/prime-v1-model/types.yaml` from a corpus, by measurement.
 *
 * The v1 compatibility model is the type contract every `.prime` atom is
 * normalized against, and `additionalFields: reject` means a field the model
 * does not declare fails the whole unit. The field set was originally
 * reverse-engineered from a 32-atom sample, which rejected 582 of the 899 units
 * in the shipped corpus — the model was the reason bundle production could not
 * move onto the kernel pipeline, not the emitter.
 *
 * A field set that is measured has to be re-measurable: the corpus gains fields
 * (a license backfill adds `source:` to hundreds of units), and hand-editing
 * 28 type definitions after every such change is how the sample-of-32 model got
 * stale in the first place. Re-run this script instead.
 *
 * Rules, all falsifiable against the corpus:
 *   - field set per kind = the measured union of declared field keys
 *   - typeRef `string` only when EVERY occurrence is a String AST node
 *     (`normalizer.convert()` rejects Ident/Array/Object against `string`);
 *     otherwise `unknown`
 *   - `required` is carried over from the current model, and demoted to false
 *     when the corpus shows the field is not present on every unit of its kind
 *   - existing field descriptions are preserved; the measurement is appended
 *
 * Usage:
 *   bun scripts/derive-compat-model.ts --src <corpus-sources-dir> [--model <dir>]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { parseLegacy } from "../packages/parser/src/index.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const at = argv.indexOf(name); return at >= 0 && argv[at + 1] ? argv[at + 1]! : fallback; };
const srcDir = resolve(flag("--src", ""));
const modelDir = resolve(flag("--model", join(HERE, "..", "compat", "prime-v1-model")));
if (!flag("--src", "")) { console.error("usage: bun scripts/derive-compat-model.ts --src <corpus-sources-dir> [--model <dir>]"); process.exit(2); }

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith(".prime")) out.push(path);
  }
  return out;
}

interface FieldStat { count: number; types: Record<string, number> }
/**
 * `extends` is a structural DSL keyword, not a field key
 * (spec/PRIME-PROTOCOL-v1.md §2). A corpus line that spells it is declaring a
 * base unit, and declaring it as a *field* would let the model claim a contract
 * the language never gave it.
 */
const NOT_A_FIELD = new Set(["extends"]);
const byKind = new Map<string, { units: number; fields: Map<string, FieldStat> }>();
let unparsed = 0;

for (const file of walk(srcDir)) {
  const parsed = parseLegacy(readFileSync(file, "utf8"), file);
  // A unit the parser cannot fully read is left OUT of the measurement: its
  // fields are unknown, and inventing them would put an unmeasured contract in
  // a file whose whole point is that every field is measured.
  if (parsed.errors.length > 0 || parsed.ast.type !== "AtomDeclaration") { unparsed++; continue; }
  const kind = (parsed.ast as { kind: string }).kind;
  let bucket = byKind.get(kind);
  if (!bucket) { bucket = { units: 0, fields: new Map() }; byKind.set(kind, bucket); }
  bucket.units++;
  for (const entry of (parsed.ast as { body: Array<{ key: string; value: { type: string } }> }).body) {
    if (NOT_A_FIELD.has(entry.key)) continue;
    let stat = bucket.fields.get(entry.key);
    if (!stat) { stat = { count: 0, types: {} }; bucket.fields.set(entry.key, stat); }
    stat.count++;
    stat.types[entry.value.type] = (stat.types[entry.value.type] ?? 0) + 1;
  }
}

const typesPath = join(modelDir, "types.yaml");
const source = readFileSync(typesPath, "utf8");
const header = source.slice(0, source.indexOf("kind: definitions")).trimEnd();
const doc = YAML.parse(source) as { definitions: Array<{ kind: string; name: string; version: string; additionalFields?: string; fields: Array<{ name: string; typeRef: string; required?: boolean; description?: string }> }> };

const changes: string[] = [];
const lines: string[] = [header, "", "kind: definitions", "version: 1.0.0", "definitions:"];
const shape = (stat: FieldStat) => Object.entries(stat.types).sort(([a], [b]) => (a < b ? -1 : 1)).map(([type, n]) => `${type}=${n}`).join("/");

for (const definition of doc.definitions) {
  if (definition.kind !== "type") throw new Error(`Unexpected definition kind in types.yaml: ${definition.kind}`);
  const measured = byKind.get(definition.name);
  const existing = new Map(definition.fields.map(field => [field.name, field]));
  const order = definition.fields.map(field => field.name);
  if (measured) for (const name of [...measured.fields.keys()].sort()) if (!existing.has(name)) order.push(name);

  lines.push("  - kind: type", `    name: ${definition.name}`, `    version: ${definition.version}`, `    additionalFields: ${definition.additionalFields ?? "reject"}`);
  lines.push(`    # Measured over ${measured?.units ?? 0} corpus units of this kind by scripts/derive-compat-model.ts.`);
  lines.push("    fields:");

  for (const name of order) {
    const prior = existing.get(name);
    const stat = measured?.fields.get(name);
    const allString = stat ? Object.keys(stat.types).length === 1 && stat.types.String !== undefined : undefined;

    let typeRef = prior?.typeRef ?? "unknown";
    if (stat && typeRef === "string" && allString === false) { typeRef = "unknown"; changes.push(`${definition.name}.${name}: typeRef string -> unknown (${shape(stat)})`); }
    if (!prior) typeRef = allString ? "string" : "unknown";

    let required = prior?.required === true;
    if (required && (!stat || stat.count !== measured!.units)) { required = false; changes.push(`${definition.name}.${name}: required true -> false (${stat?.count ?? 0}/${measured?.units ?? 0})`); }

    let description: string;
    if (!prior) { description = `Measured on ${stat!.count}/${measured!.units} ${definition.name} units; AST ${shape(stat!)}.`; changes.push(`${definition.name}.${name}: ADDED (${stat!.count}/${measured!.units})`); }
    else description = `${(prior.description ?? "").replace(/\s*Corpus: .*$/, "")} Corpus: ${stat ? `${stat.count}/${measured!.units} units, AST ${shape(stat)}` : `0/${measured?.units ?? 0} units`}.`.trim();

    lines.push(`      - { name: ${name}, typeRef: ${typeRef}, required: ${required}, description: ${JSON.stringify(description)} }`);
  }
}

writeFileSync(typesPath, lines.join("\n") + "\n", "utf8");
console.log(`${[...byKind.values()].reduce((sum, bucket) => sum + bucket.units, 0)} units measured across ${byKind.size} kinds; ${unparsed} unparsable and excluded`);
console.log(`${changes.filter(entry => entry.includes("ADDED")).length} fields added, ${changes.filter(entry => !entry.includes("ADDED")).length} declarations corrected`);
for (const entry of changes.filter(item => !item.includes("ADDED"))) console.log(`  ${entry}`);
