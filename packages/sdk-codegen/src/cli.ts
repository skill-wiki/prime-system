#!/usr/bin/env bun
/**
 * @module cli
 *
 * `aoe-sdk-codegen --model <dir> --out <dir>`.
 *
 * This exists because codegen is a *toolchain* step (plan §8/§14: the LSP and the
 * generators are Toolchain, not production Runtime), so the way it affects the
 * system is by being run, not by being imported. Writing files is kept here rather
 * than in `generateSdk` so the library stays usable by a conformance check that
 * wants to compile in a scratch directory and delete it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { loadModel } from "@aoe/model-schema";
import { generateSdk } from "./generate.ts";

interface Options {
  readonly model: string;
  readonly out: string;
}

function usage(message: string): never {
  process.stderr.write(`${message}\n\nUsage: aoe-sdk-codegen --model <model-package-dir> --out <output-dir>\n`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--")) usage(`Unexpected argument '${flag ?? ""}'`);
    if (value === undefined) usage(`Flag ${flag} needs a value`);
    values.set(flag.slice(2), value);
  }
  const model = values.get("model");
  const out = values.get("out");
  if (model === undefined) usage("--model is required");
  if (out === undefined) usage("--out is required");
  for (const [flag] of values) if (flag !== "model" && flag !== "out") usage(`Unknown flag --${flag}`);
  return { model, out };
}

export function run(argv: readonly string[]): number {
  const options = parseArgs(argv);
  const loaded = loadModel(resolve(options.model));
  if (!loaded.ok) {
    for (const diagnostic of loaded.diagnostics) {
      process.stderr.write(`${diagnostic.code}: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}\n`);
    }
    return 1;
  }
  const generated = generateSdk(loaded.value);
  const outDir = resolve(options.out);
  mkdirSync(outDir, { recursive: true });
  for (const file of generated.files) {
    // Emitted paths are generator-controlled, but the check is cheap and this is
    // the one place a path reaches a filesystem write.
    if (isAbsolute(file.path) || file.path.split("/").includes("..")) {
      throw new Error(`Refusing to write outside the output directory: ${file.path}`);
    }
    writeFileSync(join(outDir, file.path), file.content, "utf8");
  }
  process.stdout.write(
    `${loaded.value.manifest.name}@${loaded.value.manifest.version} digest=${generated.modelDigest} ` +
      `files=${generated.files.length} tools=${generated.mcp.tools.length} out=${outDir}\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
