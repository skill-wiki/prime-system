import { expect, test } from "bun:test";
import { join } from "node:path";
import { parse } from "@skill-wiki/parser";
import { loadModel } from "@skill-wiki/model-schema";
import { normalizeUnit, normalizePrimeV1Atom, applyV1SyntaxMacro } from "../src/normalizer.ts";
import { compile } from "../src/index.ts";
const modelResult=loadModel(join(import.meta.dir,"../../model-schema/test/fixtures/ticket-model")); if(!modelResult.ok) throw new Error("fixture model failed"); const context={corpus:"test",version:"1.0.0",digest:"sha256:test"};
test("normalizes generic unit with every typed value kind",()=>{const r=parse('unit TicketOne : Ticket { title: "x" priority: 2 active: true owner: Owner.alice metadata: { nested: ["s", 1, false, Owner.alice] } }',"ticket.prime");expect(r.errors).toHaveLength(0);if(r.ast.type!=="UnitDeclaration")throw new Error("not unit");const n=normalizeUnit(r.ast,modelResult.value,context);expect(n.ok).toBe(true);if(n.ok){expect(n.value.fields.title?.kind).toBe("string");expect(n.value.fields.priority?.kind).toBe("number");expect(n.value.fields.active?.kind).toBe("boolean");expect(n.value.fields.owner?.kind).toBe("reference");expect(n.value.fields.metadata?.kind).toBe("object");const object=n.value.fields.metadata;if(object?.kind==="object")expect(object.fields.nested?.kind).toBe("array");expect(n.value.provenance.source.filename).toBe("ticket.prime");}});
test("an unquoted Ident normalizes to a string typed value tagged with its own provenance",()=>{
  // The v1 corpus writes unquoted scalars (`domain: physics`, `confidence: strong`).
  // The parser reports these as Ident, not String — normalizer must accept them
  // for an `unknown` field without inventing a new TypedValueIR variant.
  const r=parse('unit Bare : Ticket { title: "x" }');if(r.ast.type!=="UnitDeclaration")throw new Error("not unit");
  const withIdent=parse('unit WithIdent : Ticket { title: "x" metadata: physics }');if(withIdent.ast.type!=="UnitDeclaration")throw new Error("not unit");
  const n=normalizeUnit(withIdent.ast,modelResult.value,context);expect(n.ok).toBe(true);
  if(n.ok){const value=n.value.fields.metadata;expect(value?.kind).toBe("string");if(value?.kind==="string"){expect(value.value).toBe("physics");expect(value.declaredTypeRef).toBe("ident");}}
  // An Ident used where the model expects a real `string` scalar still fails
  // closed: the corpus never writes a quoted required field unquoted, and the
  // fix must not blur that boundary.
  const asRequiredString=parse('unit Bad2 : Ticket { title: unquoted }');if(asRequiredString.ast.type!=="UnitDeclaration")throw new Error("not unit");
  const rejected=normalizeUnit(asRequiredString.ast,modelResult.value,context);expect(rejected.ok).toBe(false);if(!rejected.ok)expect(rejected.diagnostics.map(d=>d.code)).toContain("PRIMITIVE_MISMATCH");
});
test("the full v1 corpus normalizes with zero diagnostics through the Ident-aware convertUnknown",()=>{
  // Architecture-proof-adjacent regression: this is the exact failure mode L2
  // measured against the real corpus (32/32 atoms, 53 UNSUPPORTED_VALUE before
  // this fix). One representative case pinned here; the full 32-file sweep is
  // run as a throwaway script during verification, not checked into the repo.
  const compat=loadModel(join(import.meta.dir,"../../../compat/prime-v1-model"));if(!compat.ok)throw new Error("compat failed");
  const r=parse('fact WaterBoilsAt100C { id: "@example/fact-water-boils-at-100c" version: "1.0.0" statement: "Pure water boils at 100C" confidence: strong domain: physics tags: [physics, cooking] }',"fact.prime");
  if(r.ast.type!=="AtomDeclaration")throw new Error("not atom");
  const n=normalizePrimeV1Atom(r.ast,compat.value,context);expect(n.ok).toBe(true);
  if(n.ok){expect(n.value.fields.confidence?.kind).toBe("string");expect(n.value.fields.domain?.kind).toBe("string");expect(n.value.fields.tags?.kind).toBe("array");}
});
test("fails closed for unknown fields and primitive mismatch",()=>{const r=parse('unit Bad : Ticket { title: 3 extra: "x" }');if(r.ast.type!=="UnitDeclaration")throw new Error("not unit");const n=normalizeUnit(r.ast,modelResult.value,context);expect(n.ok).toBe(false);if(!n.ok)expect(n.diagnostics.map(d=>d.code)).toEqual(expect.arrayContaining(["PRIMITIVE_MISMATCH","UNKNOWN_FIELD","MISSING_REQUIRED_FIELD"]));});
test("adapts legacy atom through the same UnitIR contract",()=>{const compat=loadModel(join(import.meta.dir,"../../../compat/prime-v1-model"));if(!compat.ok)throw new Error("compat failed");const r=parse('fact LegacyFact { id: "@example/legacy-fact" version: "1.0.0" statement: "open" source: { url: "https://example.com/spec", type: "primary" } }',"legacy.prime");if(r.ast.type!=="AtomDeclaration")throw new Error("not atom");const n=normalizePrimeV1Atom(r.ast,compat.value,context);expect(n.ok).toBe(true);if(n.ok){expect(n.value.typeRef).toBe("fact");expect(n.value.fields.source?.kind).toBe("object");}});
test("the v1 syntax macro rewrites a kind form into the generic envelope",()=>{const r=parse('fact LegacyFact { id: "@example/legacy-fact" version: "1.0.0" statement: "open" }',"legacy.prime");if(r.ast.type!=="AtomDeclaration")throw new Error("not atom");
  const rewritten=applyV1SyntaxMacro(r.ast,"prime-v1-compatibility");
  // The kind survives ONLY as a model-qualified type reference — plan §6.3.
  expect(rewritten.type).toBe("UnitDeclaration");
  expect(rewritten.typeRef.name).toBe("@prime-v1-compatibility/fact");
  expect(rewritten.name).toBe("LegacyFact");
  expect(rewritten.filename).toBe("legacy.prime");
  expect(rewritten.body).toBe(r.ast.body);
  expect(rewritten.loc).toEqual(r.ast.loc);
  // A kind Core has never heard of goes through the same macro unchanged.
  const widget=parse('Widget W1 { id: "@x/w1" version: "1.0.0" }');if(widget.ast.type!=="AtomDeclaration")throw new Error("not atom");
  expect(applyV1SyntaxMacro(widget.ast,"some-model").typeRef.name).toBe("@some-model/Widget");});
test("a model-qualified typeRef normalizes exactly like the bare name, and a foreign model is refused",()=>{const compat=loadModel(join(import.meta.dir,"../../../compat/prime-v1-model"));if(!compat.ok)throw new Error("compat failed");
  const body='{ id: "@example/legacy-fact" version: "1.0.0" statement: "open" }';
  const qualified=parse(`unit LegacyFact : @prime-v1-compatibility/fact ${body}`);if(qualified.ast.type!=="UnitDeclaration")throw new Error("not unit");
  const bare=parse(`unit LegacyFact : fact ${body}`);if(bare.ast.type!=="UnitDeclaration")throw new Error("not unit");
  const a=normalizeUnit(qualified.ast,compat.value,context);const b=normalizeUnit(bare.ast,compat.value,context);
  expect(a.ok).toBe(true);expect(b.ok).toBe(true);
  // Compare semantics, not source locations: the two spellings sit at different
  // columns by construction, so only kind/value/declaredTypeRef may be equal.
  const semantics=(r:typeof a)=>r.ok?Object.entries(r.value.fields).map(([k,v])=>[k,v.kind,"value" in v?v.value:undefined,v.declaredTypeRef]):[];
  if(a.ok&&b.ok){expect(a.value.typeRef).toBe("fact");expect(semantics(a)).toEqual(semantics(b));}
  const foreign=parse(`unit LegacyFact : @somebody-elses-model/fact ${body}`);if(foreign.ast.type!=="UnitDeclaration")throw new Error("not unit");
  const rejected=normalizeUnit(foreign.ast,compat.value,context);
  expect(rejected.ok).toBe(false);if(!rejected.ok)expect(rejected.diagnostics.map(d=>d.code)).toContain("FOREIGN_MODEL_TYPE_REF");});
test("reports closed-schema error codes",()=>{const cases:[string,string][]=[["unit X : Missing { }","UNKNOWN_TYPE"],["unit X : Ticket { title: \"x\" extra: 1 }","UNKNOWN_FIELD"],["unit X : Ticket { }","MISSING_REQUIRED_FIELD"],["unit X : Ticket { title: unit }","PRIMITIVE_MISMATCH"],["unit X : Ticket { title: \"x\" owner: Other.alice }","REFERENCE_TYPE_MISMATCH"],["unit X : Ticket { title: 1 title: \"x\" }","DUPLICATE_FIELD"],["unit X : Ticket { title: \"x\" priority: 1.5 }","PRIMITIVE_MISMATCH"]];for(const [input,code] of cases){const p=parse(input);if(p.ast.type!=="UnitDeclaration")throw new Error("not unit");const n=normalizeUnit(p.ast,modelResult.value,context);expect(n.ok).toBe(false);if(!n.ok)expect(n.diagnostics.map(d=>d.code)).toContain(code);}});
test("rejects invalid context and preserves value-node locations",()=>{const p=parse('unit X : Ticket {\n title: "x"\n metadata: [\n  "a",\n  2,\n  false\n ]\n owner: Owner.alice\n}',"loc.prime");if(p.ast.type!=="UnitDeclaration")throw new Error("not unit");const bad=normalizeUnit(p.ast,modelResult.value,{corpus:" ",version:"",digest:""});expect(bad.ok).toBe(false);if(!bad.ok)expect(bad.diagnostics[0]?.code).toBe("INVALID_NORMALIZE_CONTEXT");const n=normalizeUnit(p.ast,modelResult.value,context);expect(n.ok).toBe(true);if(n.ok){const a=n.value.fields.metadata;if(a?.kind!=="array")throw new Error("array");expect(a.items.map(x=>x.source.loc.line)).toEqual([4,5,6]);expect(n.value.fields.owner?.source.loc.line).toBe(8);}});
test("compile returns parser errors before generic-not-connected",async()=>{const malformed=await compile("unit X : { }");expect(malformed.success).toBe(false);expect(malformed.diagnostics[0]?.message).toContain("Expected type reference");const generic=await compile("unit X : Ticket { }");expect(generic.success).toBe(false);expect(generic.diagnostics[0]?.message).toContain("normalize API");});
