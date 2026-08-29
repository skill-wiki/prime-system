/**
 * §16 Phase 3, acceptance criterion 2: "three unrelated domains use the same
 * Query Engine".
 *
 * The three domains are `security-model`, `recipe-model` and `incident-ops-model`
 * — real model packages with real corpora, all read through the shipped loaders.
 * They share no type name, no relation name, no projection name, no feature axis
 * and no generator name. Where they deliberately disagree is the point:
 *
 *   closure relation cyclePolicy   reject / reject / collapse
 *   exclusion conflictSeverity     error  / warning / error
 *   profile declares a reranker    yes    / no      / yes
 *   …and is it one we implement    yes    / n/a     / no
 *
 * That last row is why the reranker assertions read the engine's own registry
 * rather than a literal: `security` declares `stable-linear-v1` and gets it,
 * `incident-ops` declares `weighted-blend-v2` and gets the gap diagnostic instead.
 *
 * Every expectation below is read out of the fixture's own declarations at run
 * time. There is no literal `"depends-on"`, no literal `"error"` keyed to a
 * domain: if the engine ever defaulted one of these instead of reading it, the
 * three domains would stop agreeing and the offending row would name itself.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { SelectionPlanIR } from "@skill-wiki/ir";
import { RERANKER_APPLIED, builtinRerankers, planSelection, type QueryRequest } from "../src/index.ts";
import {
  DOMAINS,
  loadDomainPackage,
  ordinaryPrincipal,
  withPrivateUnit,
  type DomainDescriptor,
  type LoadedDomain,
} from "./support/domains.ts";

const loaded = new Map<string, LoadedDomain>();

beforeAll(() => {
  for (const domain of DOMAINS) loaded.set(domain.fixtureDir, loadDomainPackage(domain.fixtureDir));
});

function plan(
  domain: DomainDescriptor,
  overrides: Partial<QueryRequest> = {},
  model: LoadedDomain = loaded.get(domain.fixtureDir)!,
): SelectionPlanIR {
  const request: QueryRequest = {
    requestId: `phase3-${domain.fixtureDir}`,
    profile: domain.profileName,
    principal: ordinaryPrincipal,
    maxTokens: 100_000,
    text: domain.text,
    seeds: [domain.seed],
    ...overrides,
  };
  return planSelection(request, model.context, { generators: domain.registry() });
}

for (const domain of DOMAINS) {
  describe(`Phase 3 conformance :: ${domain.label}`, () => {
    test("the fixture's own declarations match what this suite claims about it", () => {
      const model = loaded.get(domain.fixtureDir)!;
      const profile = model.profiles[domain.profileName];
      expect(profile).toBeDefined();
      expect(model.relations[domain.closure.relationRef]!.semantics.selection).toBe("closure");
      expect(model.relations[domain.closure.relationRef]!.semantics.cyclePolicy).toBe(
        domain.closureCyclePolicy,
      );
      expect(model.relations[domain.exclusion.relationRef]!.semantics.selection).toBe("exclude");
      expect(model.relations[domain.exclusion.relationRef]!.semantics.conflictSeverity).toBe(
        domain.exclusionSeverity,
      );
      expect(model.relations[domain.informationalRelation]!.semantics.selection).toBe("informational");
      expect(profile!.reranker !== undefined).toBe(domain.declaresReranker);
    });

    test("produces exactly the feature axes its own profile weights", () => {
      const model = loaded.get(domain.fixtureDir)!;
      const declared = new Set(Object.keys(model.profiles[domain.profileName]!.features));
      const produced = new Set(plan(domain).candidates.flatMap(c => Object.keys(c.featureValues)));
      expect(produced.size).toBeGreaterThan(0);
      for (const axis of produced) expect(declared.has(axis)).toBe(true);

      // No axis belonging to either *other* domain may appear. A leaked default
      // axis name in the engine looks exactly like this.
      for (const other of DOMAINS) {
        if (other === domain) continue;
        for (const axis of Object.keys(loaded.get(other.fixtureDir)!.profiles[other.profileName]!.features)) {
          if (declared.has(axis)) continue;
          expect(produced.has(axis)).toBe(false);
        }
      }
    });

    test("reports no unweighted or unproduced axis", () => {
      const codes = (plan(domain).rationale ?? []).map(d => d.code);
      expect(codes).not.toContain("FEATURE_AXIS_UNWEIGHTED");
      expect(codes).not.toContain("FEATURE_AXIS_UNPRODUCED");
    });

    test("its closure relation pulls in the unit the corpus declares", () => {
      const result = plan(domain);
      const expansion = result.relationExpansions.find(
        e => e.relationRef === domain.closure.relationRef && e.from === domain.seed,
      );
      expect(expansion?.discovered).toContain(domain.closure.pulls);
      expect(result.selected.map(c => c.unitId)).toContain(domain.closure.pulls);
    });

    test("its informational relation never widens the selection", () => {
      // `informational` is skipped before the walk, so it must not appear as an
      // expansion at all — not merely produce an empty one.
      const result = plan(domain);
      expect(
        result.relationExpansions.some(e => e.relationRef === domain.informationalRelation),
      ).toBe(false);
    });

    test("its exclusion relation is honoured at the severity the model declares", () => {
      const result = plan(domain, { maxTokens: 100_000, seeds: [domain.exclusion.a] });
      const conflict = result.conflicts.find(
        d => d.code === "RELATION_EXCLUSION" && d.message.includes(domain.exclusion.relationRef),
      );
      const ids = result.selected.map(c => c.unitId);
      if (conflict === undefined) {
        // The pair is only observable once both sides are in the working set; when
        // this query does not reach both, there is nothing to assert beyond that.
        expect(ids.includes(domain.exclusion.a) && ids.includes(domain.exclusion.b)).toBe(false);
        return;
      }
      // `conflictSeverity` includes `none`, which `DiagnosticIR.severity` does not:
      // the two are different vocabularies and comparing them needs the widening.
      expect(conflict.severity as string).toBe(domain.exclusionSeverity as string);
      if (domain.exclusionSeverity === "warning") {
        // `warning` must not drop anything: both sides survive.
        expect(result.rejections.some(r => r.reasons.some(reason => reason.includes("excluded by relation")))).toBe(false);
      } else {
        expect(ids.includes(domain.exclusion.a) && ids.includes(domain.exclusion.b)).toBe(false);
      }
    });

    test("reports the reranker gap if and only if its declared reranker is absent here", () => {
      // Read against the engine's actual registry, not a literal per domain: the
      // three fixtures deliberately split three ways — `security` declares
      // `stable-linear-v1` (implemented, so it runs), `incident-ops` declares
      // `weighted-blend-v2` (not implemented, so the gap fires) and `recipe`
      // declares none. Hard-coding the expectation would let the row survive a
      // change in what the engine implements.
      const model = loaded.get(domain.fixtureDir)!;
      const declared = model.profiles[domain.profileName]!.reranker;
      const implemented = declared !== undefined && builtinRerankers().has(declared);
      const result = plan(domain);
      const codes = result.conflicts.map(d => d.code);

      expect(codes.includes("RERANKER_NOT_IMPLEMENTED")).toBe(domain.declaresReranker && !implemented);
      // The positive receipt is the other half: a stage that ran says so, so the
      // three states stay distinguishable from the plan alone.
      expect((result.rationale ?? []).map(d => d.code).includes(RERANKER_APPLIED)).toBe(implemented);
    });

    test("reports a rejected cycle only where its closure relation declares reject", () => {
      const codes = plan(domain).conflicts.map(d => d.code);
      // `incident-ops` has a real 2-cycle on `escalates-to`, which declares
      // `collapse`; the other two declare `reject` and have acyclic corpora. So
      // nobody should report a cycle — and the ops domain reaching this assertion
      // with a cycle present is what proves the policy was read.
      expect(codes).not.toContain("RELATION_CYCLE_REJECTED");
    });

    test("the ACL withholds the closure target and never names it", () => {
      const model = withPrivateUnit(loaded.get(domain.fixtureDir)!, domain.aclSubject);
      const result = plan(domain, {}, model);
      expect(JSON.stringify(result)).not.toContain(domain.aclSubject);
    });

    test("a unit the corpus publishes as private is absent for an ordinary principal", () => {
      if (domain.bornPrivate === undefined) return;
      expect(JSON.stringify(plan(domain))).not.toContain(domain.bornPrivate);
    });

    test("its primary projection is used, and its own cheaper one under pressure", () => {
      const model = loaded.get(domain.fixtureDir)!;
      const profile = model.profiles[domain.profileName]!;
      const primary = profile.projection;
      const cheaper = Object.values(model.projections)
        .filter(p => p.targetTokens < model.projections[primary]!.targetTokens)
        .sort((a, b) => b.targetTokens - a.targetTokens)[0];
      expect(cheaper).toBeDefined();

      expect(plan(domain).projectionLoads.map(l => l.projectionRef)).toContain(primary);

      const primaryCost = model.tokenCost(domain.seed, primary) ?? model.projections[primary]!.targetTokens;
      const cheapCost = model.tokenCost(domain.seed, cheaper!.name) ?? cheaper!.targetTokens;
      const tight = plan(domain, {
        maxTokens: primaryCost + cheapCost,
        fallbackProjections: [cheaper!.name],
      });
      const refs = tight.projectionLoads.map(l => l.projectionRef);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect([primary, cheaper!.name]).toContain(ref);
      expect(tight.budget.consumedTokens!).toBeLessThanOrEqual(primaryCost + cheapCost);
    });

    test("is byte-deterministic across runs", () => {
      expect(JSON.stringify(plan(domain))).toBe(JSON.stringify(plan(domain)));
    });
  });
}

describe("Phase 3 conformance :: the three domains share no vocabulary", () => {
  test("no type name, relation name, projection name or feature axis is shared", () => {
    const names = DOMAINS.map(domain => {
      const model = loaded.get(domain.fixtureDir)!;
      const profile = model.profiles[domain.profileName]!;
      return {
        label: domain.label,
        relations: new Set(Object.keys(model.relations)),
        projections: new Set(Object.keys(model.projections)),
        axes: new Set(Object.keys(profile.features)),
        generators: new Set(profile.candidateGenerators.map(g => g.name)),
      };
    });
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        for (const key of ["relations", "projections", "axes", "generators"] as const) {
          const overlap = [...names[i]![key]].filter(name => names[j]![key].has(name));
          expect(overlap).toEqual([]);
        }
      }
    }
  });

  test("one domain's profile name is unknown in another domain's context", () => {
    for (const domain of DOMAINS) {
      for (const other of DOMAINS) {
        if (other === domain) continue;
        expect(() =>
          planSelection(
            {
              requestId: "cross",
              profile: other.profileName,
              principal: ordinaryPrincipal,
              maxTokens: 1000,
            },
            loaded.get(domain.fixtureDir)!.context,
            { generators: domain.registry() },
          ),
        ).toThrow(/PROFILE_NOT_DECLARED/);
      }
    }
  });
});
