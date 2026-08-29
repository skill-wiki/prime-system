/**
 * Shared test fixture: a Model Package written to a temp directory.
 *
 * The type and field names here are deliberately content-free (`container`,
 * `capsule`, `label`, `note`). Plan §3.1 forbids the engine — and therefore this
 * package and its tests — from carrying domain vocabulary, so the fixture proves
 * the machinery without naming a domain.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ModelFixture {
  readonly root: string;
}

/**
 * A two-type model: one that rejects undeclared fields, one that allows them.
 * That pair is what makes the `additionalFields` branch testable.
 */
export function writeModelFixture(): ModelFixture {
  const root = mkdtempSync(join(tmpdir(), "w10g-model-"));
  writeFileSync(
    join(root, "prime-model.yaml"),
    ["protocol: prime/model/v2", "name: fixture-model", "version: 1.0.0", "files:", "  - types.yaml", ""].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(root, "types.yaml"),
    [
      "kind: definitions",
      "version: 1.0.0",
      "definitions:",
      "  - kind: type",
      "    name: container",
      "    version: 1.0.0",
      "    additionalFields: reject",
      "    fields:",
      "      - { name: label, typeRef: string, required: true, description: The container label }",
      "      - { name: note, typeRef: string, required: false }",
      "  - kind: type",
      "    name: capsule",
      "    version: 2.1.0",
      "    additionalFields: unknown",
      "    fields:",
      "      - { name: label, typeRef: string, required: true }",
      "",
    ].join("\n"),
    "utf8"
  );
  return { root };
}

/** A model root whose manifest is invalid, for the load-failure path. */
export function writeBrokenModelFixture(): ModelFixture {
  const root = mkdtempSync(join(tmpdir(), "w10g-model-broken-"));
  writeFileSync(join(root, "prime-model.yaml"), ["protocol: prime/model/v2", "name: broken-model", "version: not-a-semver", "files:", "  - types.yaml", ""].join("\n"), "utf8");
  writeFileSync(join(root, "types.yaml"), ["kind: definitions", "version: 1.0.0", "definitions:", "  - { kind: type, name: container, version: 1.0.0 }", ""].join("\n"), "utf8");
  return { root };
}
