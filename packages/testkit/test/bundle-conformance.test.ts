import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `realpathSync`: the loader refuses a symlink ancestor, and macOS `/var` is one. */
const TMP = realpathSync(tmpdir());
import { finalizeCorpusBundle } from "@aoe/bundle";
import { runBundleConformance } from "../src/bundle-conformance.ts";

/**
 * Every fixture is built by the real emitter (`finalizeCorpusBundle`) rather
 * than hand-written, so a suite that only ever passed against bytes this test
 * chose cannot exist: the manifest digests are computed by the producer, and a
 * check that disagrees with the producer fails here rather than in production.
 */

const MODEL = { "test-model": "1.0.0" };

function unitDir(root: string, id: string, body: Record<string, unknown>): void {
  const dir = join(root, id);
  mkdirSync(join(dir, "chunks"), { recursive: true });
  writeFileSync(join(dir, "chunks", "core.md"), `# ${id}\n`);
  const lines = [`id: "${id}"`, ...Object.entries(body).map(([k, v]) => `${k}: ${v}`)];
  writeFileSync(join(dir, "atom.yaml"), `${lines.join("\n")}\n`);
}

function bundle(options: {
  readonly corpus: string;
  readonly units: readonly { readonly id: string; readonly body: Record<string, unknown> }[];
  /** Ids to advertise in `_index.xml`. Defaults to exactly the unit ids. */
  readonly indexed?: readonly string[];
}): string {
  const root = mkdtempSync(join(TMP, "bundle-conformance-"));
  for (const unit of options.units) unitDir(root, unit.id, unit.body);
  const advertised = options.indexed ?? options.units.map(u => u.id);
  const total = advertised.length;
  writeFileSync(join(root, "_index.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<prime_index version="1.0" total="${total}">\n${advertised.map(id => `  <atom id="${id}" kind="thing" tokens="1" q="1.0"/>`).join("\n")}\n</prime_index>\n`);
  finalizeCorpusBundle({
    outDir: root,
    entries: advertised.map(id => ({ id, kind: "thing", version: "1.0.0", description: `unit ${id}`, domain: "test", tags: [], tokens: { summary: 1, core: 1, full: 1 } })),
    manifest: {
      protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0", emitterVersion: "4",
      corpus: options.corpus, release: "2026-01-01", sourceRevision: "test",
      models: MODEL, schemaDigest: `sha256:${"a".repeat(64)}`, createdAt: "2026-01-01T00:00:00.000Z",
    },
  });
  return root;
}

function outcome(root: string, id: string, options?: Parameters<typeof runBundleConformance>[1]) {
  const found = runBundleConformance(root, options).checks.find(c => c.id === id);
  if (found === undefined) throw new Error(`suite produced no ${id}`);
  return found;
}

const GOOD = [{ id: "@ns/one", body: { license: '"MIT"', projection: "\n  core: \"chunks/core.md\"" } }];

describe("runBundleConformance", () => {
  test("passes a bundle the production loader accepts", () => {
    const root = bundle({ corpus: "org.example/good", units: GOOD });
    const result = runBundleConformance(root, { allowedLicenses: ["MIT"] });
    expect(result.subject).toBe("org.example/good");
    expect(result.checks.filter(c => c.status === "fail").map(c => c.id)).toEqual([]);
  });

  test("rejects a corpus identity that is a directory basename, which the loader accepts", () => {
    // This is the whole reason the check lives here: `loadCorpusSnapshot` takes
    // `hello-world` without complaint, so BC-MANIFEST passes and BC-NAMESPACE is
    // the only thing standing between a machine-local name and a aoe:// URI.
    const root = bundle({ corpus: "hello-world", units: GOOD });
    expect(outcome(root, "BC-MANIFEST").status).toBe("pass");
    const ns = outcome(root, "BC-NAMESPACE");
    expect(ns.status).toBe("fail");
    expect(ns.findings.map(f => f.code)).toEqual(["BUNDLE_CORPUS_NOT_NAMESPACE"]);
  });

  test("catches an index total that disagrees with the entries it carries", () => {
    // `finalizeCorpusBundle` is the authoritative index writer, so the skew has
    // to be introduced after it — which is also how the live bundle acquired it
    // (`total="898"` over 899 entries). BC-MANIFEST therefore fails on the digest
    // too, and that is the point: the parity check reads the file itself rather
    // than trusting a manifest it might not have been able to verify.
    const root = bundle({ corpus: "org.example/off-by-one", units: GOOD });
    const indexPath = join(root, "_index.xml");
    writeFileSync(indexPath, readFileSync(indexPath, "utf8").replace(/total="\d+"/, 'total="7"'));
    expect(outcome(root, "BC-MANIFEST").findings.map(f => f.code)).toEqual(["INDEX_DIGEST_MISMATCH"]);
    const parity = outcome(root, "BC-INDEX-PARITY");
    expect(parity.status).toBe("fail");
    expect(parity.findings.map(f => f.code)).toEqual(["BUNDLE_INDEX_TOTAL_MISMATCH"]);
  });

  test("names a unit directory the index does not advertise, which retrieval cannot reach", () => {
    const root = bundle({
      corpus: "org.example/unindexed",
      units: [...GOOD, { id: "@ns/hidden", body: { license: '"MIT"', projection: "\n  core: \"chunks/core.md\"" } }],
      indexed: ["@ns/one"],
    });
    const parity = outcome(root, "BC-INDEX-PARITY");
    expect(parity.status).toBe("fail");
    expect(parity.findings.map(f => f.subject)).toEqual(["@ns/hidden"]);
    expect(parity.findings.map(f => f.code)).toEqual(["BUNDLE_UNIT_UNINDEXED"]);
  });

  test("catches a projection path the emitter never wrote", () => {
    const root = bundle({
      corpus: "org.example/missing-projection",
      units: [{ id: "@ns/one", body: { license: '"MIT"', projection: "\n  core: \"chunks/nope.md\"" } }],
    });
    const projections = outcome(root, "BC-PROJECTIONS");
    expect(projections.status).toBe("fail");
    expect(projections.findings.map(f => f.code)).toEqual(["BUNDLE_PROJECTION_MISSING"]);
  });

  test("catches a relation target that is not a unit in the bundle", () => {
    const root = bundle({
      corpus: "org.example/dangling",
      units: [{ id: "@ns/one", body: {
        license: '"MIT"', projection: "\n  core: \"chunks/core.md\"",
        relations: '\n  - { type: related, target: "@ns/gone" }',
      } }],
    });
    const relations = outcome(root, "BC-RELATION-TARGETS");
    expect(relations.status).toBe("fail");
    expect(relations.findings.map(f => f.code)).toEqual(["BUNDLE_DANGLING_RELATION"]);
  });

  test("reports license presence with no policy, and membership with one", () => {
    const root = bundle({
      corpus: "org.example/licenses",
      units: [
        { id: "@ns/none", body: { projection: "\n  core: \"chunks/core.md\"" } },
        { id: "@ns/gpl", body: { license: '"GPL-3.0"', projection: "\n  core: \"chunks/core.md\"" } },
      ],
    });
    expect(outcome(root, "BC-LICENSE").findings.map(f => f.code)).toEqual(["BUNDLE_LICENSE_MISSING"]);
    expect(outcome(root, "BC-LICENSE", { allowedLicenses: ["MIT", "Apache-2.0"] }).findings.map(f => f.code))
      .toEqual(["BUNDLE_LICENSE_DENIED", "BUNDLE_LICENSE_MISSING"]);
  });

  test("reads the license field the caller names, never a field this file chose", () => {
    const root = bundle({
      corpus: "org.example/field",
      units: [{ id: "@ns/one", body: { spdx: '"MIT"', projection: "\n  core: \"chunks/core.md\"" } }],
    });
    expect(outcome(root, "BC-LICENSE").status).toBe("fail");
    expect(outcome(root, "BC-LICENSE", { licenseField: "spdx", allowedLicenses: ["MIT"] }).status).toBe("pass");
  });

  test("fails closed rather than throwing when the directory is not a bundle", () => {
    const root = mkdtempSync(join(TMP, "bundle-conformance-empty-"));
    const result = runBundleConformance(root);
    expect(result.status).toBe("fail");
    expect(outcome(root, "BC-MANIFEST").findings.map(f => f.code)).toEqual(["BUNDLE_INDEX_MISSING"]);
  });

  test("a tampered index fails at BC-MANIFEST, not at a shape check", () => {
    const root = bundle({ corpus: "org.example/tampered", units: GOOD });
    writeFileSync(join(root, "_index.xml"), "<?xml version=\"1.0\"?>\n<prime_index version=\"1.0\" total=\"0\"/>\n");
    expect(outcome(root, "BC-MANIFEST").findings.map(f => f.code)).toEqual(["INDEX_DIGEST_MISMATCH"]);
  });
});
