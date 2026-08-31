import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { finalizeCorpusBundle } from "../src/index";
import { compileUnit, emitCompiledUnit } from "@skill-wiki/compiler";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import type { CompiledUnitIR } from "@skill-wiki/ir";

/**
 * Phase 2 acceptance ③: "the same input produces a byte-deterministic Bundle".
 *
 * W6-A recorded the three example corpora as DETERMINISTIC; W9-B §4.3 could not
 * reproduce that and stopped without a mechanism. These tests pin the mechanism
 * rather than the symptom: what varied between two builds of identical sources
 * was the *corpus identity*, and corpus identity is a content-digest input —
 * `computeCompiledUnitContentDigest` hashes the whole `unit.identity`. A caller
 * that derives that identity from the output directory therefore makes the
 * bundle a function of where it was written, and an output path is not an input.
 *
 * The invariant defended here is relocation invariance: two builds of the same
 * sources, same model, same declared corpus identity and same release instant
 * must be byte-identical no matter which directory they land in. That is the
 * testable form of "byte-deterministic", because a build that is only stable
 * when it reuses one fixed directory is not reproducible on another machine.
 */

const TICKET_MODEL = join(import.meta.dir, "../../model-schema/test/fixtures/ticket-model");

/** A fixed instant: a wall clock makes every manifest differ by construction. */
const FIXED_CREATED_AT = "2026-08-28T00:00:00.000Z";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Declaration order is deliberately not sorted here.
 *
 * A deterministic pipeline must not depend on the order units arrive in, and the
 * production entry point discovers them with an unsorted `readdirSync`, so the
 * fixture reproduces an arbitrary order instead of hiding it behind a sort.
 */
const SOURCES: readonly string[] = [
  'unit INC-42 : Ticket { title: "Fix login" priority: 1 active: true owner: Owner.alice metadata: { area: "auth" } }',
  'unit INC-07 : Ticket { title: "Rotate keys" priority: 3 active: true owner: Owner.bob metadata: { area: "infra" } }',
  'unit INC-99 : Ticket { title: "Purge cache" priority: 2 active: false owner: Owner.alice metadata: { area: "cdn" } }',
];

/** Compile the fixture corpus into `outDir` under an explicit corpus identity. */
function build(outDir: string, corpus: string): readonly CompiledUnitIR[] {
  const model = loadModelOrThrow(TICKET_MODEL);
  const units: CompiledUnitIR[] = [];
  for (const source of SOURCES) {
    const compiled = compileUnit(source, model, {
      corpus,
      version: "1.0.0",
      digest: `sha256:${sha256(Buffer.from(source, "utf8"))}`,
    });
    if (!compiled.ok) throw new Error(compiled.diagnostics.map(d => d.message).join("; "));
    emitCompiledUnit(compiled.value, outDir);
    units.push(compiled.value);
  }
  finalizeCorpusBundle({
    outDir,
    units,
    manifest: {
      protocolVersion: "2.0.0",
      irVersion: "2",
      compilerVersion: "2.1.0",
      emitterVersion: "4",
      corpus,
      release: FIXED_CREATED_AT.slice(0, 10),
      sourceRevision: "git:test",
      models: { [model.manifest.name]: model.manifest.version },
      schemaDigest: `sha256:${sha256(Buffer.from("fixed-schema", "utf8"))}`,
      createdAt: FIXED_CREATED_AT,
    },
  });
  return units;
}

/** Every regular file under `root`, keyed by its POSIX-relative path. */
function snapshotBytes(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else files.set(relative(root, full).split(sep).join("/"), sha256(readFileSync(full)));
    }
  };
  visit(root);
  return files;
}

/** One digest over every artifact byte in a bundle, so any mismatch anywhere fails. */
function bundleDigest(root: string): string {
  const hash = createHash("sha256");
  for (const [path, fileDigest] of [...snapshotBytes(root)].sort(([x], [y]) => (x < y ? -1 : 1))) hash.update(`${path}:${fileDigest};`);
  return hash.digest("hex");
}

function withRoots<T>(count: number, body: (roots: readonly string[]) => T): T {
  const roots = Array.from({ length: count }, () => mkdtempSync(join(realpathSync(tmpdir()), "prime-determinism-")));
  try {
    return body(roots);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

test("the same corpus compiled into different output roots is byte-identical", () => {
  withRoots(2, ([left, right]) => {
    build(left!, "org.example/tickets");
    build(right!, "org.example/tickets");
    const a = snapshotBytes(left!);
    const b = snapshotBytes(right!);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    expect([...a.keys()].filter(path => a.get(path) !== b.get(path)).sort()).toEqual([]);
  });
});

test("three consecutive builds agree on every artifact byte", () => {
  withRoots(3, roots => {
    const digests = roots.map(root => {
      build(root, "org.example/tickets");
      return bundleDigest(root);
    });
    expect(new Set(digests).size).toBe(1);
  });
});

test("corpus identity is a content-digest input, so it must never be derived from the output location", () => {
  // The mechanism behind W9-B §4.3: the production entry point derived the
  // corpus name from `--out`, so the same sources written to /tmp/a and /tmp/b
  // produced two different `content_hash` values. The digest reacting to corpus
  // identity is correct — a unit in another corpus is another unit — which is
  // precisely why that identity must come from a declared input.
  withRoots(2, ([left, right]) => {
    const asA = build(left!, "a");
    const asB = build(right!, "b");
    expect(asA.map(unit => unit.meta.id)).toEqual(asB.map(unit => unit.meta.id));
    expect(asA.map(unit => unit.meta.contentDigest)).not.toEqual(asB.map(unit => unit.meta.contentDigest));
    const read = (root: string) => (JSON.parse(readFileSync(join(root, "corpus.manifest.json"), "utf8")) as { contentDigest: string }).contentDigest;
    expect(read(left!)).not.toBe(read(right!));
  });
});

test("a bundle whose units disagree with the manifest about their corpus is refused", () => {
  // Relocation invariance is only meaningful if the recorded corpus identity is
  // the one the units were compiled under. Without this gate a caller can label
  // a bundle `hello-world` while every unit inside carries the digest of some
  // other corpus, and every later digest check would still pass.
  withRoots(1, ([root]) => {
    const model = loadModelOrThrow(TICKET_MODEL);
    const compiled = compileUnit(SOURCES[0]!, model, { corpus: "org.example/tickets", version: "1.0.0", digest: `sha256:${sha256(Buffer.from("x", "utf8"))}` });
    if (!compiled.ok) throw new Error(compiled.diagnostics.map(d => d.message).join("; "));
    emitCompiledUnit(compiled.value, root!);
    expect(() => finalizeCorpusBundle({
      outDir: root!,
      units: [compiled.value],
      manifest: {
        protocolVersion: "2.0.0", irVersion: "2", compilerVersion: "2.1.0", emitterVersion: "4",
        corpus: "org.example/other", release: FIXED_CREATED_AT.slice(0, 10), sourceRevision: "git:test",
        models: { [model.manifest.name]: model.manifest.version },
        schemaDigest: `sha256:${sha256(Buffer.from("fixed-schema", "utf8"))}`, createdAt: FIXED_CREATED_AT,
      },
    })).toThrow(/corpus/i);
  });
});
