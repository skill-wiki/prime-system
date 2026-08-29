/**
 * Golden query regression. Nine frozen observations — three per domain, across
 * both plan entry points — compared field by field against files on disk.
 *
 * The suite is only worth its cost if it actually fails when ranking changes, so
 * the last two tests prove exactly that: perturbing a feature weight, and
 * perturbing the corpus, each must change at least one observation. A golden
 * suite that stays green under both is a golden suite that measures nothing.
 *
 * Regenerate with:  UPDATE_GOLDEN=1 bun test packages/query-engine/test/golden-query.test.ts
 * Regeneration is opt-in because a golden that rewrites itself on failure is a
 * test that can never fail.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RetrievalProfile } from "@skill-wiki/model-schema";
import { planSelection } from "../src/index.ts";
import { DOMAINS, loadDomainPackage, ordinaryPrincipal, type LoadedDomain } from "./support/domains.ts";
import { GOLDEN_CASES, canonical, runGolden, type GoldenObservation } from "./support/golden.ts";

const GOLDEN_DIR = resolve(import.meta.dir, "golden");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";
const loaded = new Map<string, LoadedDomain>();

beforeAll(() => {
  for (const domain of DOMAINS) loaded.set(domain.fixtureDir, loadDomainPackage(domain.fixtureDir));
  if (UPDATE && !existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });
});

function goldenPath(name: string): string {
  return resolve(GOLDEN_DIR, `${name.replace(/\//g, "__")}.json`);
}

for (const testCase of GOLDEN_CASES) {
  describe(`golden :: ${testCase.name}`, () => {
    test("matches the frozen observation", () => {
      const actual = runGolden(testCase, loaded.get(testCase.domain.fixtureDir)!);
      const path = goldenPath(testCase.name);
      if (UPDATE) {
        writeFileSync(path, canonical(actual), "utf8");
        return;
      }
      expect(existsSync(path)).toBe(true);
      const expected = JSON.parse(readFileSync(path, "utf8")) as GoldenObservation;

      // Compared field by field rather than as one blob: a failure then names the
      // dimension that moved (order vs conflicts vs budget) instead of dumping the
      // whole plan and leaving the reader to diff it.
      expect(actual.snapshot).toEqual(expected.snapshot);
      expect(actual.request).toEqual(expected.request);
      expect(actual.topK).toEqual(expected.topK);
      expect(actual.conflicts).toEqual(expected.conflicts);
      expect(actual.budget).toEqual(expected.budget);
      expect(actual.projectionLoads).toEqual(expected.projectionLoads);
      expect(actual.rejections).toEqual(expected.rejections);
      // And the whole thing, so a field added to the observation without a golden
      // refresh is caught rather than silently unasserted.
      expect(canonical(actual)).toBe(canonical(expected));
    });

    test("is reproducible within a single process", () => {
      const model = loaded.get(testCase.domain.fixtureDir)!;
      expect(canonical(runGolden(testCase, model))).toBe(canonical(runGolden(testCase, model)));
    });
  });
}

describe("golden :: the frozen observations cover every dimension the criterion names", () => {
  test("at least one golden per domain freezes a non-empty top-k", () => {
    for (const domain of DOMAINS) {
      const observations = GOLDEN_CASES.filter(c => c.domain === domain).map(c =>
        runGolden(c, loaded.get(domain.fixtureDir)!),
      );
      expect(observations.some(o => o.topK.length > 0)).toBe(true);
    }
  });

  test("at least one golden freezes a non-empty conflict set", () => {
    const observations = GOLDEN_CASES.map(c => runGolden(c, loaded.get(c.domain.fixtureDir)!));
    expect(observations.some(o => o.conflicts.length > 0)).toBe(true);
  });

  test("the starved-budget goldens freeze an explicit over-budget state, per D-2", () => {
    // D-2: an over-budget hard closure must produce an explicit state routed into
    // `conflicts`, not a skimmable line in `rationale`. Both halves are frozen.
    //
    // What D-2 forbids is dropping a *hard-required* unit in order to fit. It does
    // not forbid dropping a soft preference — L3 §7.2 places that membership call
    // with the solver on purpose, since a preference that cannot fit even at the
    // cheapest tier genuinely cannot be admitted. So the assertion is that the
    // mandatory set survives *and* the plan admits to being over budget, not that
    // nothing was dropped at all.
    const starved = GOLDEN_CASES.filter(c => c.path === "planWithConstraints");
    expect(starved.length).toBe(DOMAINS.length);
    for (const testCase of starved) {
      const observation = runGolden(testCase, loaded.get(testCase.domain.fixtureDir)!);
      expect(observation.budget.state).not.toBeNull();
      if (observation.budget.state === "exceeded-at-cheapest-projection") {
        expect(observation.budget.shortfall).not.toBeNull();
        expect(observation.conflicts.map(c => c.code)).toContain(
          "BUDGET_EXCEEDED_AT_CHEAPEST_PROJECTION",
        );
        // The mandatory seed and everything its closure hard-requires stayed in.
        expect(observation.topK).toContain(testCase.domain.seed);
        expect(observation.topK).toContain(testCase.domain.closure.pulls);
        // And none of them was rejected for a budget reason.
        const rejected = new Set(observation.rejections.map(r => r.unitId));
        expect(rejected.has(testCase.domain.seed)).toBe(false);
        expect(rejected.has(testCase.domain.closure.pulls)).toBe(false);
        // Kept rather than trimmed: consumption exceeds the budget by the shortfall.
        expect(observation.budget.consumedTokens).toBe(
          observation.budget.maxTokens + observation.budget.shortfall!,
        );
      }
    }
  });

  test("the planSelection goldens record no budget state, which is a real gap not an omission", () => {
    // `planSelection` does not populate `budget.state`; see the report's §2. The
    // golden freezes that fact so filling the slot in shows up as a diff rather
    // than as an invisible behaviour change.
    for (const testCase of GOLDEN_CASES.filter(c => c.path === "planSelection")) {
      expect(runGolden(testCase, loaded.get(testCase.domain.fixtureDir)!).budget.state).toBeNull();
    }
  });
});

describe("golden :: the suite detects the changes it exists to detect", () => {
  test("perturbing one feature weight changes at least one observation", () => {
    for (const domain of DOMAINS) {
      const model = loaded.get(domain.fixtureDir)!;
      const testCase = GOLDEN_CASES.find(c => c.domain === domain && c.path === "planSelection")!;
      const before = canonical(runGolden(testCase, model));

      const profile = model.profiles[domain.profileName]!;
      const axis = testCase.perturbAxis;
      expect(Object.keys(profile.features)).toContain(axis);
      // Invert the axis that dominates the ranking. Any consumer-visible reorder
      // has to surface here, otherwise the golden is not reading the ranking.
      const perturbed: RetrievalProfile = {
        ...profile,
        features: { ...profile.features, [axis]: -profile.features[axis]! },
      };
      const request = testCase.build(domain);
      const after = canonical(
        planSelection(
          request,
          { ...model.context, profiles: { ...model.profiles, [domain.profileName]: perturbed } },
          { generators: domain.registry() },
        ).selected.map(c => c.unitId),
      );
      expect(after).not.toBe(canonical(JSON.parse(before).topK));
    }
  });

  test("perturbing the corpus changes the frozen snapshot, so a moved corpus cannot pass", () => {
    for (const domain of DOMAINS) {
      const model = loaded.get(domain.fixtureDir)!;
      const testCase = GOLDEN_CASES.find(c => c.domain === domain && c.path === "planSelection")!;
      const shifted: LoadedDomain = {
        ...model,
        graph: { ...model.graph, snapshot: { ...model.graph.snapshot, corpusRelease: "9.9.9" } },
        context: {
          ...model.context,
          graph: { ...model.graph, snapshot: { ...model.graph.snapshot, corpusRelease: "9.9.9" } },
        },
      };
      const frozen = JSON.parse(readFileSync(goldenPath(testCase.name), "utf8")) as GoldenObservation;
      expect(runGolden(testCase, shifted).snapshot).not.toEqual(frozen.snapshot);
    }
  });

  test("an unknown principal id changes the frozen request echo", () => {
    const domain = DOMAINS[0]!;
    const model = loaded.get(domain.fixtureDir)!;
    const plan = planSelection(
      {
        requestId: `golden-${domain.fixtureDir}`,
        profile: domain.profileName,
        principal: { ...ordinaryPrincipal, id: "someone-else" },
        maxTokens: 100_000,
        text: domain.text,
        seeds: [domain.seed],
      },
      model.context,
      { generators: domain.registry() },
    );
    expect(JSON.stringify(plan.query)).toContain("someone-else");
  });
});
