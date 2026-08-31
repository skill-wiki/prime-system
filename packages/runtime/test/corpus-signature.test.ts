import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORPUS_SIGNATURE_FILE,
  CorpusSignatureError,
  verifyCorpusSignature,
  writeCorpusSignature,
} from "../src/corpus-signature.ts";

function withBundle(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "prime-signature-"));
  writeFileSync(join(root, "corpus.manifest.json"), '{"corpus":"org.example/test","release":"r1"}\n');
  try { body(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("corpus release signature", () => {
  it("writes deterministic bytes and verifies the exact manifest", () => withBundle(root => {
    writeCorpusSignature(root);
    const first = readFileSync(join(root, CORPUS_SIGNATURE_FILE), "utf8");
    writeCorpusSignature(root);
    expect(readFileSync(join(root, CORPUS_SIGNATURE_FILE), "utf8")).toBe(first);
    expect(verifyCorpusSignature(root, { required: true })?.algorithm).toBe("sha256");
  }));

  it("fails closed when the manifest changes after signing", () => withBundle(root => {
    writeCorpusSignature(root);
    writeFileSync(join(root, "corpus.manifest.json"), '{"corpus":"org.example/test","release":"r2"}\n');
    expect(() => verifyCorpusSignature(root, { required: true })).toThrow(CorpusSignatureError);
  }));

  it("distinguishes optional legacy bundles from a required missing signature", () => withBundle(root => {
    expect(verifyCorpusSignature(root)).toBeUndefined();
    expect(() => verifyCorpusSignature(root, { required: true })).toThrow(/requires signature\.json/);
  }));
});
