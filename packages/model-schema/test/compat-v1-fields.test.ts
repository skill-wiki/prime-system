import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModel, type TypeDefinition } from "../src/index.ts";

const compat = join(import.meta.dir, "../../../compat/prime-v1-model");
const roots: string[] = [];
const codes = (root: string) => { const r = loadModel(root); return r.ok ? [] : r.diagnostics.map(d => d.code); };
function fixture(definitions: string): string { const root = mkdtempSync(join(tmpdir(), "compat-fields-")); roots.push(root); writeFileSync(join(root, "prime-model.yaml"), "protocol: prime/model/v2\nname: x\nversion: 1.0.0\nfiles: [d.yaml]\n"); writeFileSync(join(root, "d.yaml"), `kind: definitions\nversion: 1.0.0\ndefinitions: ${definitions}\n`); return root; }
function types(): readonly TypeDefinition[] { const r = loadModel(compat); if (!r.ok) throw new Error(`compat model failed: ${r.diagnostics.map(d => d.code).join(",")}`); return r.value.definitions.filter((d): d is TypeDefinition => d.kind === "type"); }
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

// The 9 kinds that actually occur in the Kernary Engine's compatibility examples. The other 19 have zero
// corpus instances, so their kind-specific field sets are unmeasurable rather than empty.
const ATTESTED = ["anti-pattern", "collection", "fact", "method", "pattern", "principle", "rule", "term", "tradeoff"];

describe("prime-v1 compat type fields", () => {
  test("loads and no type is an empty shell any more", () => { const ts = types(); expect(ts).toHaveLength(28); for (const t of ts) expect(t.fields.length).toBeGreaterThan(0); });

  // `required` is claimed only when the field is the kind's semantic payload AND is present on
  // 100% of corpus instances AND n>=4. Universal metadata (domain/tags/notes/related) also hits
  // 100% on some kinds, but that corpus is single-authored, so 100% there is house style rather
  // than a protocol obligation -- claiming it would break the first atom that omits it.
  //
  // The earlier version of this test pinned a LIST of kind-specific required fields, measured
  // against a 32-atom sample. Re-measured against all 797 sources that build the bundle, every
  // one of those claims fails its own 100% rule:
  //
  //     rule.label              12/167   7%     <- required, and absent from 93% of rules
  //     anti-pattern.instead-do 20/53   38%
  //     anti-pattern.why-bad    23/53   43%
  //     pattern.label          103/133  77%
  //     pattern.solution       107/133  80%
  //     pattern.problem        109/133  82%
  //     anti-pattern.label      49/53   92%
  //     term.meaning              8/9   89%
  //     fact.statement           78/83  94%
  //
  // That gap was 375 MISSING_REQUIRED_FIELD errors when the kernel path tried to compile the
  // real corpus. So the assertion is now the RULE rather than a list: no kind may claim a
  // required field beyond identity unless its coverage is actually total. Re-tightening one
  // means re-measuring it, which is the property worth pinning -- a list only pinned a sample.
  test("no kind claims a required field beyond identity, because none is universal", () => {
    for (const t of types()) {
      const required = t.fields.filter(f => f.required).map(f => f.name).sort();
      expect(required).toEqual(["id", "version"]);
    }
  });

  test("kind-defining fields are declared where the corpus attests them", () => { const of = (name: string) => { const t = types().find(x => x.name === name); if (!t) throw new Error(`missing type ${name}`); return t.fields.map(f => f.name); }; expect(of("fact")).toEqual(expect.arrayContaining(["statement", "confidence", "source", "applies-to"])); expect(of("term")).toEqual(expect.arrayContaining(["meaning", "aliases"])); expect(of("rule")).toEqual(expect.arrayContaining(["label", "checks"])); expect(of("method")).toEqual(expect.arrayContaining(["steps", "success-criteria"])); expect(of("pattern")).toEqual(expect.arrayContaining(["label", "problem", "solution"])); expect(of("anti-pattern")).toEqual(expect.arrayContaining(["why-bad", "instead-do"])); expect(of("collection")).toEqual(expect.arrayContaining(["entry-point", "includes", "target"])); expect(of("tradeoff")).toEqual(expect.arrayContaining(["axes", "cost-of-strict", "cost-of-loose", "decision"])); });

  // spec/PRIME-PROTOCOL-v1.md §2 declares 13 usable edge verbs as body fields (`extends` is a
  // structural DSL keyword, never a field key), and relations.yaml declares them all '*'->'*'.
  test("every type carries the protocol edge verbs as fields", () => { const verbs = ["related", "compatible", "conflicts", "see-also", "derived-from", "requires", "enhances", "validates-with", "supplies-to", "specializes", "contradicts", "relationships", "includes"]; for (const t of types()) { const names = t.fields.map(f => f.name); for (const v of verbs) expect(names).toContain(v); expect(names).not.toContain("extends"); } });

  test("only corpus-attested kinds close their schema", () => { const ts = types(); expect(ts.filter(t => t.additionalFields === "reject").map(t => t.name).sort()).toEqual(ATTESTED); expect(ts.filter(t => t.additionalFields === "unknown")).toHaveLength(19); });

  // A `generic:` typeRef passes the loader's builtin() check but fails compiler normalize()
  // with UNKNOWN_DECLARED_TYPE_REF, and there is no array/object typeRef in the protocol.
  // So a non-scalar field must be `unknown`; this guards against a well-meaning "improvement".
  test("no typeRef escapes the scalar-or-unknown set the normalizer accepts", () => { const allowed = new Set(["string", "number", "boolean", "integer", "unknown"]); for (const t of types()) for (const f of t.fields) expect(allowed.has(f.typeRef)).toBe(true); });

  test("every field carries its evidence in a description", () => { for (const t of types()) for (const f of t.fields) expect((f.description ?? "").length).toBeGreaterThan(0); });

  // Negative: the field shape in the architecture plan §5.2 is NOT what this schema accepts.
  test("rejects the plan §5.2 map-shaped fields block", () => { expect(codes(fixture('[{kind: type, name: X, version: 1.0.0, fields: {statement: {type: string, required: true}}}]'))).toContain("INVALID_DEFINITION_FILE"); });
  test("rejects `type` used in place of `typeRef`", () => { expect(codes(fixture('[{kind: type, name: X, version: 1.0.0, fields: [{name: a, type: string}]}]'))).toContain("INVALID_DEFINITION_FILE"); });
  test("rejects the plan §5.2 range and items keys on a field", () => { expect(codes(fixture('[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: number, range: [0, 1]}]}]'))).toContain("INVALID_DEFINITION_FILE"); expect(codes(fixture('[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: array, items: "ref:Citation"}]}]'))).toContain("INVALID_DEFINITION_FILE"); });
  test("rejects a field naming an undeclared type", () => { expect(codes(fixture('[{kind: type, name: X, version: 1.0.0, fields: [{name: a, typeRef: Citation}]}]'))).toContain("DANGLING_TYPE_REF"); });
  test("rejects a field with an empty name", () => { expect(codes(fixture('[{kind: type, name: X, version: 1.0.0, fields: [{name: "", typeRef: string}]}]'))).toContain("INVALID_DEFINITION_FILE"); });
});
