#!/usr/bin/env bun
/**
 * Infer dead-verb edges from existing atom naming hierarchies.
 *
 * 9 of 14 declared edge verbs in PRIME-SPEC §2 have 0 edges in the corpus
 * (extends, derived-from, requires, enhances, supplies-to, specializes,
 * contradicts, see-also, relationships). The graph is functionally
 * single-verb (`related` = 94%). This script reads atom ids, finds
 * implicit hierarchies in the naming convention, and writes the appropriate
 * structured edges back to the source `.prime` files.
 *
 * Heuristics:
 *
 *   1. specializes — `pattern-data-table-dense` specializes `pattern-data-table`
 *      if both exist. Also: `template-easing-spring` specializes `template-easing`,
 *      `rule-button-target-size` specializes `rule-target-size`, etc.
 *
 *   2. derived-from — `rule-color-contrast-aa` is derived-from
 *      `principle-color-accessibility` (rule that operationalizes a principle
 *      with the same root word). We require a *strong* match: rule's noun
 *      tail must be a prefix of the principle's noun tail OR vice versa.
 *
 *   3. extends — anti-pattern variants of a parent anti-pattern; counter-examples
 *      that extend an example.
 *
 *   4. see-also — for atoms whose noun-tail differs by only one suffix and the
 *      kinds are the same family but neither dominates (true peers, not
 *      specializations).
 *
 * The script is conservative: it only adds an edge when both ends exist,
 * the relationship type is unambiguous, and the source atom doesn't already
 * declare a direct edge to the proposed target.
 *
 * Usage:
 *   bun scripts/infer-dead-verb-edges.ts                # dry run
 *   bun scripts/infer-dead-verb-edges.ts --apply        # rewrite sources
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const SRC = "primes-v3/sources";

interface AtomInfo {
  id: string;
  file: string;
  kind: string;
  tail: string;        // e.g. "pattern-data-table-dense"
  noun: string;        // e.g. "data-table-dense"
  body: string;        // raw source content
  // Already-declared targets (to avoid duplicating)
  declared: Set<string>;
}

function* walk(root: string): Generator<string> {
  for (const e of readdirSync(root)) {
    const f = join(root, e);
    const s = statSync(f);
    if (s.isDirectory()) yield* walk(f);
    else if (e.endsWith(".prime")) yield f;
  }
}

const KIND_PREFIXES = [
  "pattern", "anti-pattern", "rule", "principle", "template", "fact",
  "check", "constraint", "example", "counter-example", "method",
  "tradeoff", "tool", "metric", "term", "value", "type", "transform",
  "category", "taxonomy", "step", "source", "feedback", "scope",
  "provocation", "voice", "persona", "collection",
];

function splitTail(id: string): { kind: string; noun: string; tail: string } | null {
  const slash = id.lastIndexOf("/");
  const tail = slash >= 0 ? id.slice(slash + 1) : id;
  for (const k of KIND_PREFIXES) {
    if (tail === k) return { kind: k, noun: "", tail };
    if (tail.startsWith(k + "-")) {
      return { kind: k, noun: tail.slice(k.length + 1), tail };
    }
  }
  return null;
}

function readAtomInfo(file: string): AtomInfo | null {
  const body = readFileSync(file, "utf-8");
  const idMatch = body.match(/^\s*id\s*:\s*"([^"]+)"/m);
  if (!idMatch) return null;
  const id = idMatch[1];
  const split = splitTail(id);
  if (!split) return null;

  // Collect already-declared targets across every relation field.
  const declared = new Set<string>();
  const fieldRe = /^\s*(?:related|compatible|conflicts|see-also|see_also|extends|derived-from|derived_from|requires|enhances|validates_with|validates-with|supplies_to|supplies-to|specializes|contradicts|relationships|must-include|must_include|motion-prescriptions|motion_prescriptions)\s*:\s*\[([\s\S]*?)\]/gm;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(body)) !== null) {
    const refRe = /(?:"([^"]+)"|(@[\w/\-_]+))/g;
    let r: RegExpExecArray | null;
    while ((r = refRe.exec(m[1])) !== null) {
      declared.add(r[1] ?? r[2]);
    }
  }

  return { id, file, kind: split.kind, tail: split.tail, noun: split.noun, body, declared };
}

const atoms = new Map<string, AtomInfo>();
for (const f of walk(SRC)) {
  const info = readAtomInfo(f);
  if (info) atoms.set(info.id, info);
}
console.log(`Loaded ${atoms.size} atoms`);

// ─── Build noun-prefix index: parent noun → list of more-specific atoms ─────
// e.g. noun "data-table" → ["data-table-dense", "data-table-sortable", ...]
type Suggestion = { from: string; to: string; verb: string; reason: string };
const suggestions: Suggestion[] = [];

// Group atoms by kind for parent lookup
const byKindAndNoun = new Map<string, Map<string, AtomInfo>>();
for (const a of atoms.values()) {
  if (!byKindAndNoun.has(a.kind)) byKindAndNoun.set(a.kind, new Map());
  byKindAndNoun.get(a.kind)!.set(a.noun, a);
}

// Heuristic 1: specializes — same kind, child noun is parent noun + "-suffix"
for (const a of atoms.values()) {
  if (!a.noun.includes("-")) continue;
  const kindMap = byKindAndNoun.get(a.kind)!;
  // Walk up the noun: "data-table-dense" → "data-table" → "data"
  const parts = a.noun.split("-");
  for (let n = parts.length - 1; n >= 1; n--) {
    const parentNoun = parts.slice(0, n).join("-");
    const parent = kindMap.get(parentNoun);
    if (parent && parent.id !== a.id && !a.declared.has(parent.id)) {
      suggestions.push({
        from: a.id, to: parent.id, verb: "specializes",
        reason: `same-kind noun-prefix child→parent`,
      });
      break; // only nearest parent
    }
  }
}

// Heuristic 2: derived-from — rule-X derived-from principle-X (or related)
//   We match rule.noun to principle.noun where one is a prefix of the other
//   AND the principle wasn't already in the rule's declared edges.
const principleByNoun = byKindAndNoun.get("principle") ?? new Map();
const factByNoun = byKindAndNoun.get("fact") ?? new Map();
for (const a of atoms.values()) {
  if (a.kind !== "rule" && a.kind !== "check" && a.kind !== "constraint") continue;
  // Try exact noun match first, then prefix
  const exactPrinciple = principleByNoun.get(a.noun);
  if (exactPrinciple && !a.declared.has(exactPrinciple.id)) {
    suggestions.push({
      from: a.id, to: exactPrinciple.id, verb: "derived-from",
      reason: `${a.kind} → principle exact-noun match`,
    });
    continue;
  }
  // Walk parent nouns
  const parts = a.noun.split("-");
  for (let n = parts.length - 1; n >= 1; n--) {
    const parentNoun = parts.slice(0, n).join("-");
    const p = principleByNoun.get(parentNoun);
    if (p && !a.declared.has(p.id)) {
      suggestions.push({
        from: a.id, to: p.id, verb: "derived-from",
        reason: `${a.kind} → principle prefix match (${parentNoun})`,
      });
      break;
    }
    const fct = factByNoun.get(parentNoun);
    if (fct && !a.declared.has(fct.id)) {
      suggestions.push({
        from: a.id, to: fct.id, verb: "derived-from",
        reason: `${a.kind} → fact prefix match (${parentNoun})`,
      });
      break;
    }
  }
}

// Heuristic 3: extends — anti-pattern X extends pattern X (negation pair)
const patternByNoun = byKindAndNoun.get("pattern") ?? new Map();
for (const a of atoms.values()) {
  if (a.kind !== "anti-pattern") continue;
  const peer = patternByNoun.get(a.noun);
  if (peer && !a.declared.has(peer.id)) {
    suggestions.push({
      from: a.id, to: peer.id, verb: "extends",
      reason: `anti-pattern → pattern noun match (negative extension)`,
    });
  }
}

// Heuristic 4: see-also — counter-example X to example X (and vice versa)
const exampleByNoun = byKindAndNoun.get("example") ?? new Map();
const counterByNoun = byKindAndNoun.get("counter-example") ?? new Map();
for (const a of atoms.values()) {
  if (a.kind === "example" && counterByNoun.has(a.noun)) {
    const peer = counterByNoun.get(a.noun)!;
    if (!a.declared.has(peer.id)) {
      suggestions.push({
        from: a.id, to: peer.id, verb: "see-also",
        reason: `example ↔ counter-example same noun`,
      });
    }
  }
  if (a.kind === "counter-example" && exampleByNoun.has(a.noun)) {
    const peer = exampleByNoun.get(a.noun)!;
    if (!a.declared.has(peer.id)) {
      suggestions.push({
        from: a.id, to: peer.id, verb: "see-also",
        reason: `counter-example ↔ example same noun`,
      });
    }
  }
}

// Heuristic 5: requires — promote must-include refs to a `requires` edge when
// the target is a method/check/rule/constraint (functional dependencies).
// Templates and patterns are aesthetic deps already covered by `must-include`
// itself; promoting them would just duplicate the data.
for (const a of atoms.values()) {
  if (a.kind !== "pattern" && a.kind !== "template" && a.kind !== "method") continue;
  const mustIncludeMatch = a.body.match(/must-include\s*:\s*\[([\s\S]*?)\]/);
  if (!mustIncludeMatch) continue;
  const refRe = /(?:"([^"]+)"|(@[\w/\-_]+))/g;
  let r: RegExpExecArray | null;
  while ((r = refRe.exec(mustIncludeMatch[1])) !== null) {
    const target = r[1] ?? r[2];
    const t = atoms.get(target);
    if (!t) continue;
    const FUNCTIONAL = new Set(["method", "check", "rule", "constraint"]);
    if (FUNCTIONAL.has(t.kind) && !a.declared.has(target)) {
      suggestions.push({
        from: a.id, to: target, verb: "requires",
        reason: `${a.kind} → ${t.kind} (functional dependency from must-include)`,
      });
    }
  }
}

// Heuristic 6: enhances — template X enhances pattern X (template is a
// concrete refinement of an abstract pattern with the same noun).
const templateByNoun = byKindAndNoun.get("template") ?? new Map();
for (const a of atoms.values()) {
  if (a.kind !== "template") continue;
  // Look for pattern with same noun
  const peer = patternByNoun.get(a.noun);
  if (peer && !a.declared.has(peer.id)) {
    suggestions.push({
      from: a.id, to: peer.id, verb: "enhances",
      reason: `template ↔ pattern same noun (template enhances/concretes the pattern)`,
    });
  }
  // Also try parent nouns: template-card-hover-lift → pattern-card-hover
  if (!a.noun.includes("-")) continue;
  const parts = a.noun.split("-");
  for (let n = parts.length - 1; n >= 1; n--) {
    const parentNoun = parts.slice(0, n).join("-");
    const p = patternByNoun.get(parentNoun);
    if (p && !a.declared.has(p.id)) {
      suggestions.push({
        from: a.id, to: p.id, verb: "enhances",
        reason: `template noun-prefix → pattern (template enhances pattern)`,
      });
      break;
    }
  }
}

// Heuristic 7: contradicts — atoms whose bodies declare composition.must-avoid
// arrays should mirror those into `contradicts` edges (must-avoid is the
// declarative form; contradicts is the graph form).
for (const a of atoms.values()) {
  const mustAvoidMatch = a.body.match(/must-avoid\s*:\s*\[([\s\S]*?)\]/);
  if (!mustAvoidMatch) continue;
  const refRe = /(?:"([^"]+)"|(@[\w/\-_]+))/g;
  let r: RegExpExecArray | null;
  while ((r = refRe.exec(mustAvoidMatch[1])) !== null) {
    const target = r[1] ?? r[2];
    if (!atoms.has(target)) continue;
    if (a.declared.has(target)) continue;
    suggestions.push({
      from: a.id, to: target, verb: "contradicts",
      reason: `must-avoid → contradicts (avoidance is a graph-level conflict)`,
    });
  }
}

// Heuristic 9: see-also — rule X ↔ check X (both verify the same noun;
// rule states the policy, check measures it).
const ruleByNoun = byKindAndNoun.get("rule") ?? new Map();
const checkByNoun = byKindAndNoun.get("check") ?? new Map();
for (const a of atoms.values()) {
  if (a.kind === "rule") {
    const peer = checkByNoun.get(a.noun);
    if (peer && !a.declared.has(peer.id)) {
      suggestions.push({
        from: a.id, to: peer.id, verb: "see-also",
        reason: `rule ↔ check same noun (rule states policy, check measures)`,
      });
    }
  }
  if (a.kind === "check") {
    const peer = ruleByNoun.get(a.noun);
    if (peer && !a.declared.has(peer.id)) {
      suggestions.push({
        from: a.id, to: peer.id, verb: "see-also",
        reason: `check ↔ rule same noun (check measures policy stated by rule)`,
      });
    }
  }
}

// Heuristic 10: relationships — atoms whose noun-tail explicitly indicates
// a many-to-many tagging (e.g. category/taxonomy atoms that group families).
// Conservative: only fire for category atoms and only when targets are
// explicitly listed in the body's "items" / "members" array.
for (const a of atoms.values()) {
  if (a.kind !== "category" && a.kind !== "taxonomy") continue;
  // Inspect body for items: [...] arrays referencing other atoms
  const itemsMatch = a.body.match(/(?:items|members)\s*:\s*\[([\s\S]*?)\]/);
  if (!itemsMatch) continue;
  const refRe = /(?:"([^"]+)"|(@[\w/\-_]+))/g;
  let r: RegExpExecArray | null;
  while ((r = refRe.exec(itemsMatch[1])) !== null) {
    const target = r[1] ?? r[2];
    if (!atoms.has(target)) continue;
    if (a.declared.has(target)) continue;
    suggestions.push({
      from: a.id, to: target, verb: "relationships",
      reason: `category/taxonomy items → relationships (membership graph)`,
    });
  }
}

// Heuristic 8: supplies-to — fact / term / value / source / example atoms
// feed into rule / method / pattern atoms whose noun shares a prefix.
// Conservative: only fire when the supplier noun is at least a prefix of the
// consumer noun.
const SUPPLIER_KINDS = new Set(["fact", "term", "value", "source", "example", "metric"]);
const CONSUMER_KINDS = new Set(["rule", "method", "pattern", "constraint", "principle"]);
for (const a of atoms.values()) {
  if (!SUPPLIER_KINDS.has(a.kind)) continue;
  if (!a.noun) continue;
  for (const c of atoms.values()) {
    if (c.id === a.id) continue;
    if (!CONSUMER_KINDS.has(c.kind)) continue;
    // Match only when supplier noun is a strict prefix or exact match
    if (c.noun !== a.noun && !c.noun.startsWith(a.noun + "-")) continue;
    if (a.declared.has(c.id)) continue;
    suggestions.push({
      from: a.id, to: c.id, verb: "supplies-to",
      reason: `${a.kind} ${a.noun} → ${c.kind} ${c.noun} (data feeds operational atom)`,
    });
  }
}

// ─── Report ───────────────────────────────────────────────────────────────

const byVerb = suggestions.reduce((m, s) => { m[s.verb] = (m[s.verb] ?? 0) + 1; return m; }, {} as Record<string, number>);
console.log(`\nSuggestions by verb:`);
for (const [v, n] of Object.entries(byVerb)) console.log(`  ${v}: ${n}`);
console.log(`Total: ${suggestions.length}`);

console.log(`\nSamples (first 15):`);
for (const s of suggestions.slice(0, 15)) {
  console.log(`  ${s.verb.padEnd(15)} ${s.from}  →  ${s.to}    [${s.reason}]`);
}

if (!APPLY) {
  console.log(`\nDry-run. Use --apply to inject these edges into source files.`);
  process.exit(0);
}

// ─── Apply ─────────────────────────────────────────────────────────────────

// Group suggestions by source atom + verb
type ByVerb = Map<string, Set<string>>;
const byAtom = new Map<string, ByVerb>();
for (const s of suggestions) {
  if (!byAtom.has(s.from)) byAtom.set(s.from, new Map());
  const mp = byAtom.get(s.from)!;
  if (!mp.has(s.verb)) mp.set(s.verb, new Set());
  mp.get(s.verb)!.add(s.to);
}

let filesPatched = 0;
let edgesAdded = 0;
for (const [from, verbMap] of byAtom) {
  const a = atoms.get(from);
  if (!a) continue;
  let body = a.body;
  let dirty = false;
  for (const [verb, targets] of verbMap) {
    // Insert a new field block before the closing `}` of the atom.
    const block = `\n  ${verb}: [\n${[...targets].map((t) => `    ${t},`).join("\n")}\n  ]\n`;
    // Find the last `}` (atom close)
    const closeIdx = body.lastIndexOf("}");
    if (closeIdx === -1) continue;
    // Avoid double-insert on second pass
    const verbField = new RegExp(`^\\s*${verb.replace("-", "[-_]")}\\s*:`, "m");
    if (verbField.test(body)) continue;
    body = body.slice(0, closeIdx) + block + body.slice(closeIdx);
    dirty = true;
    edgesAdded += targets.size;
  }
  if (dirty) {
    writeFileSync(a.file, body, "utf-8");
    filesPatched++;
  }
}

console.log(`\nApplied ${edgesAdded} new edges across ${filesPatched} source files.`);
console.log(`Re-run \`bun scripts/build-atom-dirs.ts --src primes-v3/sources --out compiled-v3-final\` to recompile.`);
