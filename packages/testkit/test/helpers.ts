import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Writes a throwaway model package and returns its root. */
export function writeModel(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "prime-testkit-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return root;
}

export function removeTree(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Minimal loadable model: one type with one field, one projection covering it. */
export function minimalModelFiles(definitions: string): Readonly<Record<string, string>> {
  return {
    "prime-model.yaml": "protocol: prime/model/v2\nname: probe\nversion: 1.0.0\nfiles: [definitions.yaml]\n",
    "definitions.yaml": `kind: definitions\nversion: 1.0.0\ndefinitions:\n${definitions}`,
  };
}

export const PROBE_TYPE = '  - {kind: type, name: Widget, version: 1.0.0, fields: [{name: label, typeRef: string, required: true}]}\n';
export const PROBE_PROJECTION = '  - {kind: projection, name: summary, version: 1.0.0, targetTokens: 40, rules: [{typeRef: Widget, include: [label]}]}\n';
