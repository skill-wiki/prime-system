/**
 * The §14.3 gate: a generated artifact may only be used against the snapshot it
 * was generated from. Every negative path is here, because the whole value of the
 * gate is in what it *refuses* — a gate that only has a happy-path test is
 * indistinguishable from `return true`.
 */

import { describe, expect, test } from "bun:test";
import {
  assertGeneratedArtifactUsable,
  createEmbeddedTransport,
  GENERATED_ARTIFACT_PROTOCOL,
  ModelDigestMismatchError,
  parseGeneratedArtifactHeader,
  AoeClient,
  SdkError,
  type GeneratedArtifactHeader,
} from "../src/index.ts";
import { loadEngineContext, registry, SNAPSHOT } from "./support/host.ts";

const header: GeneratedArtifactHeader = {
  protocol: GENERATED_ARTIFACT_PROTOCOL,
  generator: "@aoe/sdk-codegen",
  model: { name: "security-controls", version: "1.0.0", digest: SNAPSHOT.modelDigest },
};

const aoe = new AoeClient({
  transport: createEmbeddedTransport({ snapshot: SNAPSHOT, engine: loadEngineContext(), generators: registry() }),
});

describe("generated-artifact digest gate", () => {
  test("accepts an artifact whose digest matches the activated snapshot", async () => {
    expect(await aoe.verifyGeneratedArtifact(header)).toEqual(header);
  });

  test("rejects an artifact generated against a different model digest", () => {
    const stale = { ...header, model: { ...header.model, digest: "sha256:deadbeef" } };
    expect(() => assertGeneratedArtifactUsable(stale, SNAPSHOT)).toThrow(ModelDigestMismatchError);
    try {
      assertGeneratedArtifactUsable(stale, SNAPSHOT);
    } catch (error) {
      const mismatch = error as ModelDigestMismatchError;
      expect(mismatch.expected).toBe("sha256:deadbeef");
      expect(mismatch.actual).toBe(SNAPSHOT.modelDigest);
      expect(mismatch.message).toContain("@aoe/sdk-codegen");
    }
  });

  test("rejects through the client too, so a stale SDK cannot issue a call", async () => {
    await expect(
      aoe.verifyGeneratedArtifact({ ...header, model: { ...header.model, digest: "sha256:stale" } }),
    ).rejects.toThrow(ModelDigestMismatchError);
  });

  test("rejects an unknown artifact protocol rather than assuming compatibility", () => {
    expect(() => assertGeneratedArtifactUsable({ ...header, protocol: "prime/generated/v0" }, SNAPSHOT)).toThrow(
      /Unsupported generated-artifact protocol/,
    );
  });

  test("rejects a snapshot that carries no model digest, instead of passing vacuously", () => {
    expect(() => assertGeneratedArtifactUsable(header, { ...SNAPSHOT, modelDigest: "" })).toThrow(
      /carries no model digest/,
    );
  });

  test.each([
    ["not an object", 42],
    ["missing protocol", { generator: "g", model: header.model }],
    ["missing generator", { protocol: GENERATED_ARTIFACT_PROTOCOL, model: header.model }],
    ["missing model", { protocol: GENERATED_ARTIFACT_PROTOCOL, generator: "g" }],
    ["missing model.digest", { protocol: GENERATED_ARTIFACT_PROTOCOL, generator: "g", model: { name: "n", version: "1.0.0" } }],
    ["empty model.digest", { protocol: GENERATED_ARTIFACT_PROTOCOL, generator: "g", model: { name: "n", version: "1.0.0", digest: "" } }],
  ])("rejects a malformed header (%s) instead of defaulting a field", (_label, value) => {
    expect(() => parseGeneratedArtifactHeader(value)).toThrow(SdkError);
  });
});
