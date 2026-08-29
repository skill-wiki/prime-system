#!/usr/bin/env bun
/**
 * corpus-reconcile — emit a reproducible three-way reconciliation manifest.
 *
 *   bun packages/corpus-tools/src/cli.ts \
 *     --root /Users/houxianchao/Desktop/prime \
 *     --out  /Users/houxianchao/Desktop/prime/docs/analysis/corpus-reconciliation
 *
 * Reads only; writes only the two files under --out.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLegacy, loadMigrated, loadV3 } from "./load.ts";
import { reconcile, tally, type LegacyRow, type V3Row } from "./reconcile.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

// `--v3-sources` and `--v3-compiled` are REQUIRED and deliberately have no
// defaults. They previously defaulted to one particular domain corpus's paths,
// which put that domain's name in engine source (ZDS-CORE-VOCABULARY) and also
// made the tool quietly reconcile the wrong corpus when run from elsewhere.
// A reconciler is generic; which corpus it reads is the caller's statement.
const root = arg("root", process.cwd());
const out = arg("out", join(root, "docs/analysis/corpus-reconciliation"));
const sourcesRel = arg("v3-sources");
const compiledRel = arg("v3-compiled");

const t0 = Date.now();
const legacy = loadLegacy(root);
const migrated = loadMigrated(root);
const v3 = loadV3(root, sourcesRel, compiledRel);
const r = reconcile(legacy.units, migrated.units, v3.units);
const elapsed = Date.now() - t0;

mkdirSync(out, { recursive: true });

const legacyTally = tally(r.legacy);
const v3Tally = tally(r.v3);

const manifest = {
  schema: "prime/corpus-reconciliation/v1",
  generatedBy: "packages/corpus-tools/src/cli.ts",
  generatedAt: new Date().toISOString(),
  inputs: {
    root,
    legacy: {
      trees: ["primes/atoms", "primes/modules"],
      scanned: legacy.report.scanned,
      parsed: legacy.report.parsed,
      skipped: legacy.report.skipped.length,
      skippedDetail: legacy.report.skipped,
    },
    migrated: {
      tree: "packages/compiler/fixtures/migrated",
      gitTracked: false,
      canonical: false,
      scanned: migrated.report.scanned,
      parsed: migrated.report.parsed,
      skipped: migrated.report.skipped,
    },
    bundle: {
      sources: sourcesRel,
      compiled: compiledRel,
      scanned: v3.report.scanned,
      parsed: v3.report.parsed,
      skipped: v3.report.skipped,
    },
  },
  tiers: {
    order: [
      "slug-exact",
      "slug-kindstripped-exact",
      "slug-tokenset",
      "prose-digest",
      "provenance-repo-file",
      "slug-jaccard-0.80",
    ],
    demoted: {
      "provenance-url":
        "Removed after the first run: a shared upstream repo URL matched unrelated v3 units and manufactured bogus `split` verdicts. Now recorded under `weakHints` and never used for a verdict.",
    },
    mappedTiers: ["slug-exact", "slug-kindstripped-exact"],
    note: "Only the two exact-identifier tiers yield `mapped`. Every weaker tier yields `renamed`, because a weaker tier firing means the identifier itself changed. `unmapped` = no tier fired.",
  },
  summary: {
    legacy: legacyTally,
    bundle: v3Tally,
    migratedVsLegacy: {
      legacyTotal: r.migratedCoverage.legacyTotal,
      migratedTotal: r.migratedCoverage.migratedTotal,
      matchedPairs: r.migratedCoverage.matchedPairs,
      legacyWithoutMigrated: r.migratedCoverage.legacyWithoutMigrated.length,
      migratedWithoutLegacy: r.migratedCoverage.migratedWithoutLegacy.length,
      nameCollisionKeys: r.migratedCoverage.nameCollisions.length,
    },
    edges: r.edges.length,
    weakHints: r.weakHints.length,
    elapsedMs: elapsed,
  },
  legacy: r.legacy,
  bundle: r.v3,
  migrated: r.migrated,
  edges: r.edges,
  weakHints: r.weakHints,
  migratedCoverage: r.migratedCoverage,
};

const manifestPath = join(out, "reconciliation.manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// ---- unmapped lists: the point of the exercise -------------------------
const unmappedLegacy = r.legacy.filter((x) => x.verdict === "unmapped");
const unmappedV3 = r.v3.filter((x) => x.verdict === "unmapped");

function group<T>(rows: T[], key: (r: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const row of rows) {
    const k = key(row) || "<none>";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

const lines: string[] = [];
lines.push("# UNMAPPED — units whose destination cannot be proven");
lines.push("");
lines.push(`Generated ${manifest.generatedAt} by \`packages/corpus-tools/src/cli.ts\`.`);
lines.push("");
lines.push(
  "`unmapped` means: no slug match, no kind-stripped slug match, no token-set match, no prose digest match, no repo+file provenance match, no URL provenance match, and no 0.80 Jaccard slug overlap. It is a statement about evidence, not about intent."
);
lines.push("");
lines.push(`## Legacy side — ${unmappedLegacy.length} of ${r.legacy.length}`);
lines.push("");
lines.push("| group | n |");
lines.push("|---|---|");
for (const [k, n] of group(unmappedLegacy, (x: LegacyRow) => `ns \`@${x.ns}\``))
  lines.push(`| ${k} | ${n} |`);
lines.push("");
lines.push("### by subtype");
lines.push("");
lines.push("| subtype | n |");
lines.push("|---|---|");
for (const [k, n] of group(unmappedLegacy, (x: LegacyRow) => x.subtype ?? "")) lines.push(`| ${k} | ${n} |`);
lines.push("");
lines.push("### by license (publication-relevant)");
lines.push("");
lines.push("| license | n |");
lines.push("|---|---|");
for (const [k, n] of group(unmappedLegacy, (x: LegacyRow) => x.license ?? "")) lines.push(`| ${k} | ${n} |`);
lines.push("");
lines.push(`## Bundle side — ${unmappedV3.length} of ${r.v3.length} (v3-only, no legacy ancestor)`);
lines.push("");
lines.push("| namespace | n |");
lines.push("|---|---|");
for (const [k, n] of group(unmappedV3, (x: V3Row) => `\`@${x.ns}\``)) lines.push(`| ${k} | ${n} |`);
lines.push("");
lines.push("| kind | n |");
lines.push("|---|---|");
for (const [k, n] of group(unmappedV3, (x: V3Row) => x.kind)) lines.push(`| ${k} | ${n} |`);
lines.push("");
lines.push("## Full id lists");
lines.push("");
lines.push("<details><summary>legacy unmapped ids</summary>");
lines.push("");
lines.push("```");
for (const x of unmappedLegacy) lines.push(x.id);
lines.push("```");
lines.push("");
lines.push("</details>");
lines.push("");
lines.push("<details><summary>bundle unmapped ids</summary>");
lines.push("");
lines.push("```");
for (const x of unmappedV3) lines.push(x.id);
lines.push("```");
lines.push("");
lines.push("</details>");
lines.push("");

const unmappedPath = join(out, "UNMAPPED.md");
writeFileSync(unmappedPath, lines.join("\n"));

// ---- console summary ---------------------------------------------------
console.log(`legacy   scanned=${legacy.report.scanned} parsed=${legacy.report.parsed} skipped=${legacy.report.skipped.length}`);
console.log(`migrated scanned=${migrated.report.scanned} parsed=${migrated.report.parsed}`);
console.log(`bundle   scanned=${v3.report.scanned} parsed=${v3.report.parsed}`);
console.log(`edges    ${r.edges.length}  weakHints ${r.weakHints.length}  elapsed ${elapsed}ms`);
console.log("");
console.log("legacy verdicts:", JSON.stringify(legacyTally));
console.log("bundle verdicts:", JSON.stringify(v3Tally));
console.log("migrated vs legacy:", JSON.stringify(manifest.summary.migratedVsLegacy));
console.log("");
console.log("tier histogram:", JSON.stringify(tallyBy(r.edges.map((e) => e.tier))));
console.log("");
console.log(`wrote ${manifestPath}`);
console.log(`wrote ${unmappedPath}`);

function tallyBy(xs: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}
