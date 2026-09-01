/**
 * §17.2's `CC-GOLDEN-QUERY` check has shipped skipped since it was written —
 * `no query implementation injected` — because `testkit` deliberately does not
 * import a query engine. The injection point belongs on this side of the
 * dependency edge, so this is where the check is actually closed.
 *
 * The expectations are read out of the frozen golden files rather than typed
 * again: two independent copies of the same expected ranking would drift, and the
 * one that drifted silently would be this one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadModelOrThrow } from "@aoe/model-schema";
import { loadCorpus, runCorpusConformance, type GoldenQuery, type GoldenQueryObservation } from "@aoe/testkit";
import { planSelection } from "../src/index.ts";
import { DOMAINS, loadDomainPackage, ordinaryPrincipal } from "./support/domains.ts";
import type { GoldenObservation } from "./support/golden.ts";

const FIXTURES = resolve(import.meta.dir, "../../testkit/fixtures");

function frozen(name: string): GoldenObservation {
  return JSON.parse(readFileSync(resolve(import.meta.dir, "golden", `${name}.json`), "utf8")) as GoldenObservation;
}

for (const domain of DOMAINS) {
  describe(`CC-GOLDEN-QUERY :: ${domain.label}`, () => {
    const root = resolve(FIXTURES, domain.fixtureDir);
    const model = loadModelOrThrow(root);
    const corpus = loadCorpus(resolve(root, "corpus/units.yaml"));
    const loaded = loadDomainPackage(domain.fixtureDir);
    const observation = frozen(`${domain.fixtureDir}__roomy-ranked`);

    const goldenQueries: readonly GoldenQuery[] = [
      {
        name: `${domain.fixtureDir}/roomy-ranked`,
        request: { text: domain.text, seeds: [domain.seed], maxTokens: observation.budget.maxTokens },
        expectedUnitIds: observation.topK,
        expectedConflictCodes: observation.conflicts.map(c => c.code),
        expectedBudget: {
          maxTokens: observation.budget.maxTokens,
          ...(observation.budget.consumedTokens === null
            ? {}
            : { consumedTokens: observation.budget.consumedTokens }),
        },
      },
    ];

    const runQueryPlan = (request: Readonly<Record<string, unknown>>): GoldenQueryObservation => {
      const plan = planSelection(
        {
          requestId: `cc-golden-${domain.fixtureDir}`,
          profile: domain.profileName,
          principal: ordinaryPrincipal,
          maxTokens: request["maxTokens"] as number,
          text: request["text"] as string,
          seeds: request["seeds"] as readonly string[],
        },
        loaded.context,
        { generators: domain.registry() },
      );
      return {
        unitIds: plan.selected.map(candidate => candidate.unitId),
        conflictCodes: plan.conflicts.map(d => d.code),
        budget: {
          maxTokens: plan.budget.maxTokens,
          ...(plan.budget.consumedTokens === undefined ? {} : { consumedTokens: plan.budget.consumedTokens }),
          ...(plan.budget.state === undefined ? {} : { state: plan.budget.state }),
          ...(plan.budget.shortfall === undefined ? {} : { shortfall: plan.budget.shortfall }),
        },
      };
    };

    test("the corpus suite's golden-query check passes with the real engine injected", () => {
      expect(corpus.ok).toBe(true);
      if (!corpus.ok) return;
      const report = runCorpusConformance(corpus.value, model, {
        allowedLicenses: ["Apache-2.0"],
        goldenQueries,
        runQueryPlan,
      });
      const check = report.checks.find(c => c.id === "CC-GOLDEN-QUERY");
      expect(check?.status).toBe("pass");
      expect(report.status).not.toBe("fail");
    });

    test("a wrong expected ranking fails the check rather than being tolerated", () => {
      if (!corpus.ok) return;
      const report = runCorpusConformance(corpus.value, model, {
        goldenQueries: [{ ...goldenQueries[0]!, expectedUnitIds: [...goldenQueries[0]!.expectedUnitIds].reverse() }],
        runQueryPlan,
      });
      const check = report.checks.find(c => c.id === "CC-GOLDEN-QUERY");
      expect(check?.status).toBe("fail");
      expect(check?.findings.map(f => f.code)).toContain("GOLDEN_QUERY_MISMATCH");
    });

    test("a conflict or budget expectation the injector cannot answer is reported, not skipped", () => {
      if (!corpus.ok) return;
      // `runQuery` returns ids only. An expectation about conflicts must then be
      // an explicit finding: silently treating it as satisfied is the failure mode
      // §17.5 calls a skip disguised as a pass.
      const report = runCorpusConformance(corpus.value, model, {
        goldenQueries,
        runQuery: request => runQueryPlan(request).unitIds,
      });
      const codes = report.checks.find(c => c.id === "CC-GOLDEN-QUERY")?.findings.map(f => f.code) ?? [];
      expect(codes).toContain("GOLDEN_QUERY_CONFLICTS_UNCHECKED");
      expect(codes).toContain("GOLDEN_QUERY_BUDGET_UNCHECKED");
    });
  });
}
