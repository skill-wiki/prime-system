/**
 * @module domain-config
 * Config-driven domain extension for Prime Wiki.
 *
 * Allows teams to add a new knowledge domain (security, ML, cooking, legal, …)
 * by dropping a single `domain.yaml` file alongside their corpus — no TypeScript
 * editing required.
 *
 * Entry points:
 *   - `loadDomainFromFile(path)`   — parse one domain.yaml, return DomainPlugin
 *   - `discoverDomains(rootDir?)`  — scan for domain.yaml files recursively (depth ≤ MAX_DISCOVERY_DEPTH)
 *   - `registerAll(registry, plugins)` — bulk-register into a DomainRegistry
 *   - `createConfigDrivenRegistry(rootDir?)` — convenience: discover + register, no built-ins
 *
 * The DomainPlugin objects produced here are fully compatible with the interface
 * defined in domain-plugin.ts. There are NO built-in code-defined domains;
 * ALL domains come from domain.yaml files discovered at startup.
 *
 * @see spec/DOMAIN-EXTENSION-SPEC.md for the normative schema reference.
 */

import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import * as path from "path";
import type { PrimeAST, FieldNode, ArrayNode, StringNode, IdentNode } from "@skill-wiki/types";
import {
  DomainRegistry,
  type DomainPlugin,
  type DomainDiagnostic,
} from "./domain-plugin";

// ─── Discovery constants ──────────────────────────────────────────────────────

/**
 * Maximum directory depth for recursive domain.yaml discovery.
 * Prevents runaway scans on monorepos with deeply nested node_modules.
 * Depth 0 = the root itself; depth 4 means up to 4 levels below the root.
 */
export const MAX_DISCOVERY_DEPTH = 4;

// ─── Tag regex ────────────────────────────────────────────────────────────────

/**
 * Unicode-aware tag validation pattern.
 * Accepts letters (any script: 中文, sauté, スケ, αβγ, ASCII), digits, and
 * hyphens. The first and last characters must be letter/digit (no leading or
 * trailing hyphen). Maximum 64 characters.
 *
 * For brief-to-domain matching: ASCII tags are matched case-insensitively
 * (both sides lowercased). Non-ASCII tags use literal (already-lowercased)
 * comparison; authors should store tags in their canonical script form.
 */
const TAG_REGEX = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,62}[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u;

// ─── Zod Schema ──────────────────────────────────────────────────────────────

const KEBAB_CASE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Schema for a single retrieval axis definition.
 * Unknown fields are tolerated (passthrough) for forward compatibility with
 * future spec versions that may add axis-level metadata.
 */
const AxisDefSchema = z
  .object({
    name: z.string().regex(KEBAB_CASE, "axis name must be kebab-case, 1–64 chars"),
    description: z.string().min(1).max(256),
    matches: z
      .array(z.string().min(1))
      .min(1, "an axis must have at least one match term")
      .max(500),
  })
  .passthrough();

export type AxisDef = z.infer<typeof AxisDefSchema>;

/**
 * Supported contract field types.  See DOMAIN-EXTENSION-SPEC §3.4.
 */
const ContractFieldTypeSchema = z.enum([
  "atom-id-array",
  "string-array",
  "enum",
  "enum-array",
  "string",
  "boolean",
]);

/**
 * Schema for a single composition-contract field declaration.
 * Unknown keys are stripped but not rejected (forward compat).
 */
const ContractFieldSchema = z
  .object({
    type: ContractFieldTypeSchema,
    description: z.string().optional(),
    values: z.array(z.string()).optional(),
  })
  .passthrough();

export type ContractField = z.infer<typeof ContractFieldSchema>;

/**
 * Schema for a single output validator declaration.
 * Unknown keys are stripped but not rejected (forward compat).
 * The `checker` string is validated syntactically at load time; regex
 * patterns are compiled immediately so syntax errors surface early.
 */
const ValidatorDefSchema = z
  .object({
    name: z.string().regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "validator name must be kebab-case"
    ),
    description: z.string().min(1),
    checker: z.string().min(1),
  })
  .passthrough();

export type ValidatorDef = z.infer<typeof ValidatorDefSchema>;

/**
 * Top-level schema for a `domain.yaml` file.
 * Matches the normative Zod schema in DOMAIN-EXTENSION-SPEC Appendix A.
 *
 * Unknown top-level fields are stripped (z.object default behavior), not
 * rejected.  This ensures domain.yaml files authored for future spec versions
 * load without error in v0.1.0 runtimes.
 *
 * Tags use the Unicode-aware TAG_REGEX: any script's letters/digits + hyphens.
 * Tags are stored verbatim (already lowercased by the author); matching is
 * case-insensitive for ASCII characters and literal for non-ASCII.
 */
const DomainConfigSchema = z.object({
  name: z.string().regex(KEBAB_CASE, "name must be kebab-case, 1–64 chars"),
  version: z.string().regex(SEMVER, "version must be semver (MAJOR.MINOR.PATCH)"),
  description: z.string().min(1).max(512),
  tags: z
    .array(
      z.string().regex(
        TAG_REGEX,
        "each tag must be a Unicode letter/digit sequence with optional hyphens (no leading/trailing hyphen)"
      )
    )
    .max(200)
    .default([]),
  axes: z.array(AxisDefSchema).default([]),
  contract: z.record(z.string(), ContractFieldSchema).default({}),
  validators: z.array(ValidatorDefSchema).default([]),
});

export type DomainConfig = z.infer<typeof DomainConfigSchema>;

// ─── Extended Plugin Type ─────────────────────────────────────────────────────

/**
 * The DomainPlugin produced by this module extends the base interface with
 * the extra metadata fields from domain.yaml.  Code that wants these extra
 * fields can check `'sourceFile' in plugin` to narrow to this type.
 */
export interface LoadedDomainPlugin extends DomainPlugin {
  readonly version: string;
  readonly description: string;
  readonly axes: ReadonlyArray<AxisDef>;
  readonly contract: Readonly<Record<string, ContractField>>;
  readonly validators: ReadonlyArray<ValidatorDef>;
  /** Absolute path to the domain.yaml file that produced this plugin. */
  readonly sourceFile: string;
}

// ─── Regex validator cache ────────────────────────────────────────────────────

/**
 * Pre-compile regex checkers at load time so syntax errors surface early
 * rather than at first validation run.
 */
function compileChecker(validator: ValidatorDef, sourceFile: string): RegExp | null {
  const { checker, name } = validator;
  if (checker.startsWith("builtin:")) return null;
  if (checker.startsWith("regex:")) {
    const inner = checker.slice("regex:".length);
    // Pattern must be wrapped in /…/ with optional flags after closing slash
    const match = inner.match(/^\/(.+)\/([gimsuy]*)$/);
    if (!match) {
      console.warn(
        `[prime-wiki] WARN: validator "${name}" in ${sourceFile}: ` +
          `regex checker must be in /pattern/flags format — validator skipped`
      );
      return null;
    }
    try {
      return new RegExp(match[1], match[2] || undefined);
    } catch (err) {
      console.warn(
        `[prime-wiki] WARN: validator "${name}" in ${sourceFile}: ` +
          `invalid regex — ${(err as Error).message} — validator skipped`
      );
      return null;
    }
  }
  // Unknown checker prefix — warn and skip
  console.warn(
    `[prime-wiki] WARN: validator "${name}" in ${sourceFile}: ` +
      `unknown checker prefix "${checker.split(":")[0]}" — validator skipped`
  );
  return null;
}

// ─── scopeCheck helper ────────────────────────────────────────────────────────

/**
 * Build a scopeCheck function for a config-loaded domain.
 *
 * Checks are performed in this order (first match wins):
 *   1. The atom's `domain:` field equals the domain name (case-insensitive).
 *   2. Any of the atom's `tags:` intersect the domain's tag vocabulary.
 *
 * Tag matching: ASCII tags are compared case-insensitively (both sides
 * lowercased). Non-ASCII tags are stored verbatim and matched literally
 * against the lowercased tag set built from the domain vocabulary.
 */
function buildScopeCheck(
  domainName: string,
  tags: ReadonlyArray<string>
): (ast: PrimeAST) => boolean {
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));

  return function scopeCheck(ast: PrimeAST): boolean {
    const fields = ast.body ?? [];

    // 1. Check domain: field.
    //    The parser emits Ident for unquoted values (e.g. `domain: cooking`)
    //    and String for quoted values (e.g. `domain: "cooking"`). Handle both.
    const domainField = fields.find(
      (x): x is FieldNode => x.type === "Field" && x.key === "domain"
    );
    if (domainField) {
      const v = domainField.value;
      const raw =
        v.type === "String"
          ? (v as StringNode).value
          : v.type === "Ident"
          ? (v as IdentNode).value
          : null;
      if (raw && raw.toLowerCase() === domainName.toLowerCase()) return true;
    }

    // 2. Check tags: field.
    //    Tags can be unquoted identifiers (Ident) or quoted strings (String).
    const tagsField = fields.find(
      (x): x is FieldNode => x.type === "Field" && x.key === "tags"
    );
    if (tagsField && tagsField.value.type === "Array") {
      for (const item of (tagsField.value as ArrayNode).items) {
        const raw =
          item.type === "String"
            ? (item as StringNode).value
            : item.type === "Ident"
            ? (item as IdentNode).value
            : null;
        if (raw && tagSet.has(raw.toLowerCase())) return true;
      }
    }

    return false;
  };
}

// ─── Core loaders ────────────────────────────────────────────────────────────

/**
 * Parse and validate a single `domain.yaml` file, returning a `DomainPlugin`
 * that satisfies the interface in `domain-plugin.ts`.
 *
 * Throws on hard validation errors (missing required fields, invalid semver,
 * etc.).  Regex compilation errors are non-fatal: the offending validator is
 * skipped with a warning.
 *
 * @param filePath  Absolute or relative path to the `domain.yaml` file.
 */
export function loadDomainFromFile(filePath: string): LoadedDomainPlugin {
  const absolutePath = path.resolve(filePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`domain.yaml not found: ${absolutePath}`);
  }

  let raw: unknown;
  try {
    const content = readFileSync(absolutePath, "utf-8");
    raw = parseYaml(content);
  } catch (err) {
    throw new Error(
      `Failed to parse YAML at ${absolutePath}: ${(err as Error).message}`
    );
  }

  const result = DomainConfigSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `  at "${i.path.join(".")}": ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid domain.yaml at ${absolutePath}:\n${msg}`
    );
  }

  const config = result.data;

  // Pre-compile regex checkers; remove failed ones
  const compiledRegexes = new Map<string, RegExp>();
  const validatedValidators: ValidatorDef[] = [];
  for (const validator of config.validators) {
    if (validator.checker.startsWith("builtin:")) {
      // NOTE (v0.1.0): builtin validators are parsed and stored but NOT executed.
      // The @skill-wiki/validator-core execution engine is planned for v0.2.
      // Authors may declare builtin: validators today to future-proof their
      // domain.yaml; they will be silently no-ops until validator-core ships.
      validatedValidators.push(validator);
    } else if (validator.checker.startsWith("regex:")) {
      const compiled = compileChecker(validator, absolutePath);
      if (compiled) {
        compiledRegexes.set(validator.name, compiled);
        validatedValidators.push(validator);
      }
      // else: skipped with warning already emitted
    } else {
      compileChecker(validator, absolutePath); // emits warning
    }
  }

  // Deduplicate tags (warn on first duplicate). Tags stored verbatim;
  // deduplication keyed on lowercased value.
  const seen = new Set<string>();
  const dedupedTags: string[] = [];
  for (const tag of config.tags) {
    const lower = tag.toLowerCase();
    if (seen.has(lower)) {
      console.warn(
        `[prime-wiki] WARN: duplicate tag "${tag}" in ${absolutePath} — ignoring`
      );
    } else {
      seen.add(lower);
      dedupedTags.push(tag); // store verbatim, not forced-lowercase
    }
  }

  const frozenTags = Object.freeze(dedupedTags);
  const scopeCheck = buildScopeCheck(config.name, frozenTags);

  const plugin: LoadedDomainPlugin = {
    // DomainPlugin base fields
    name: config.name,
    tags: frozenTags,
    scopeCheck,

    // LoadedDomainPlugin extended fields
    version: config.version,
    description: config.description,
    axes: Object.freeze(
      config.axes.length > 0
        ? config.axes
        : [
            {
              name: "general",
              description: "Default retrieval axis",
              matches: [],
            } satisfies AxisDef,
          ]
    ),
    contract: Object.freeze(config.contract),
    validators: Object.freeze(validatedValidators),
    sourceFile: absolutePath,
  };

  return plugin;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Scan a directory tree for domain.yaml files and load each one.
 *
 * Discovery scope:
 *   - Default: recursively walks rootDir looking for any domain.yaml,
 *     stopping at depth MAX_DISCOVERY_DEPTH (= 4) below the root to avoid
 *     runaway scans on monorepos.
 *   - Override: PRIME_DOMAINS_DIR env var (single directory, no recursion —
 *     scans star/domain.yaml directly within that directory).
 *
 * Duplicate names: first registration wins. If two domain.yaml files
 * declare the same name, the second is skipped and a warning is emitted:
 *   [prime-domain] WARN duplicate domain "X": keeping PATH1, ignoring PATH2
 *
 * @param rootDir  Directory to scan (default: process.cwd()).
 *                 Overridden by PRIME_DOMAINS_DIR env var.
 *
 * @returns Array of successfully loaded DomainPlugin objects, in lexicographic
 *          path order. Failed files are skipped with a warning; the array may
 *          be empty if no valid files are found.
 */
export function discoverDomains(rootDir?: string): LoadedDomainPlugin[] {
  // Environment variable takes precedence over argument and cwd
  const envOverride = process.env["PRIME_DOMAINS_DIR"];
  const searchRoot = path.resolve(envOverride ?? rootDir ?? process.cwd());

  let found: string[];

  if (envOverride) {
    // When PRIME_DOMAINS_DIR is set: simple one-level scan (*/domain.yaml)
    found = manualGlob(searchRoot, ["*", "domain.yaml"]).sort();
  } else {
    // Default: recursive scan up to MAX_DISCOVERY_DEPTH
    found = recursiveFind(searchRoot, "domain.yaml", MAX_DISCOVERY_DEPTH).sort();
  }

  // Deduplicate by domain name: first path wins
  const seenNames = new Map<string, string>(); // name → first absolute path
  const plugins: LoadedDomainPlugin[] = [];

  for (const filePath of found) {
    const absolutePath = path.resolve(filePath);

    // Security: ensure the file is actually inside the search root
    if (!absolutePath.startsWith(searchRoot + path.sep) && absolutePath !== searchRoot) {
      console.warn(
        `[prime-wiki] WARN: skipped ${absolutePath} — outside search root ${searchRoot}`
      );
      continue;
    }

    let plugin: LoadedDomainPlugin;
    try {
      plugin = loadDomainFromFile(absolutePath);
    } catch (err) {
      console.warn(
        `[prime-wiki] WARN: skipped domain.yaml at ${absolutePath}\n` +
          `  reason: ${(err as Error).message}`
      );
      continue;
    }

    // First-registration-wins for duplicate names
    const existingPath = seenNames.get(plugin.name);
    if (existingPath) {
      console.warn(
        `[prime-domain] WARN duplicate domain "${plugin.name}": ` +
          `keeping ${existingPath}, ignoring ${absolutePath}`
      );
      continue;
    }

    seenNames.set(plugin.name, absolutePath);
    plugins.push(plugin);
  }

  return plugins;
}

/**
 * Recursively find all files with the given filename within `dir`,
 * stopping at `maxDepth` levels below `dir` (depth 0 = dir itself).
 */
function recursiveFind(dir: string, filename: string, maxDepth: number): string[] {
  const results: string[] = [];

  function walk(current: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip hidden directories (node_modules, .git, etc.) at depth > 0
      if (depth > 0 && entry.startsWith(".")) continue;
      if (entry === "node_modules") continue;

      const full = path.join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (stat.isFile() && entry === filename) {
        results.push(full);
      }
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * One-level glob: find files matching path segments under root.
 * Supports the "* /domain.yaml" pattern used when PRIME_DOMAINS_DIR is set.
 */
function manualGlob(root: string, parts: string[]): string[] {
  const results: string[] = [];

  function walk(dir: string, remaining: string[]): void {
    if (remaining.length === 0) return;
    const [head, ...rest] = remaining;
    if (head === "*") {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        try {
          if (statSync(full).isDirectory()) {
            walk(full, rest);
          }
        } catch {
          // ignore inaccessible entries
        }
      }
    } else {
      const full = path.join(dir, head);
      if (rest.length === 0) {
        try {
          if (statSync(full).isFile()) results.push(full);
        } catch {
          // ignore
        }
      } else {
        walk(full, rest);
      }
    }
  }

  walk(root, parts);
  return results;
}

// ─── Bulk Registration ────────────────────────────────────────────────────────

/**
 * Register multiple plugins into a DomainRegistry in one call.
 *
 * First registration wins: if a domain name is already registered, the
 * incoming plugin is skipped with a warning. This is consistent with the
 * first-wins behavior of `discoverDomains`.
 *
 * @param registry  The DomainRegistry to register into.
 * @param plugins   Plugins to register (typically the output of discoverDomains).
 */
export function registerAll(
  registry: DomainRegistry,
  plugins: DomainPlugin[]
): void {
  for (const plugin of plugins) {
    const existing = registry.get(plugin.name);
    if (existing) {
      const src = "sourceFile" in plugin ? (plugin as LoadedDomainPlugin).sourceFile : "unknown";
      console.warn(
        `[prime-domain] WARN duplicate domain "${plugin.name}": ` +
          `keeping existing registration, ignoring ${src}`
      );
      continue;
    }
    registry.register(plugin);
  }
}

// ─── Convenience factory ──────────────────────────────────────────────────────

/**
 * Create a DomainRegistry populated exclusively with config-discovered domains
 * from `rootDir` (or cwd / PRIME_DOMAINS_DIR).
 *
 * There are NO built-in domains. Every domain in the returned registry was
 * loaded from a `domain.yaml` file. Bundled corpora ship their own
 * `domain.yaml` files; users can edit or replace them.
 *
 * This is the recommended entry point for MCP server and CLI startup.
 *
 * @param rootDir  Optional override for the corpus search root.
 */
export function createConfigDrivenRegistry(
  rootDir?: string
): DomainRegistry {
  const registry = new DomainRegistry();
  const discovered = discoverDomains(rootDir);
  registerAll(registry, discovered);
  if (discovered.length > 0) {
    console.error(
      `[prime-wiki] config-driven domains loaded: ${discovered.map((p) => p.name).join(", ")}`
    );
  }
  return registry;
}
