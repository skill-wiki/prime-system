# DOMAIN-EXTENSION-SPEC

**Spec Version:** 0.2.0  
**Status:** Draft  
**Authors:** Prime Wiki maintainers  
**Date:** 2026-05-09

---

## 1. Purpose and Scope

This specification describes the config-driven domain extension mechanism for the Prime Wiki runtime. It defines:

- The `domain.yaml` file schema
- How the system discovers and loads domain files at startup
- How domain configuration maps to the existing `DomainPlugin` interface
- How retrieval, composition, and validation consume domain config at runtime
- Versioning rules for the spec itself
- Items explicitly deferred to future spec versions

### What Problem This Solves

Every knowledge domain previously needed a handwritten TypeScript object registered at server boot time. Adding `security`, `machine-learning`, or `cooking` meant:

1. Editing TypeScript source code to define a hardcoded `DomainPlugin` object with a tag vocabulary.
2. Recompiling and redeploying the MCP server.

This created a fork-to-extend pattern: every team with a non-standard corpus had to maintain a patched copy of the server. The config-driven approach described here eliminates that friction. A team drops a single YAML file alongside their corpus and the system loads it at startup without any code changes.

### What This Spec Does NOT Cover

See Section 9 (Future Extensions Explicitly Out of Scope) for an exhaustive list. The headline items are:

- Custom atom kinds beyond the 28 built-in kinds
- Custom edge verbs beyond the 14 built-in verbs
- LLM-judge validators (rule-based and regex validators only in v0.1.0)
- Cross-domain composition (atoms from multiple domains in a single retrieval call)

---

## 2. No Built-in Domains

**The system ships zero hardcoded domains.** All domains are configuration. There is no special code path for `frontend-design`, `security`, or `accessibility` — they are plain `domain.yaml` files shipped with their respective corpus packages.

This means:

- A `DomainRegistry` created at startup is always empty until `discoverDomains()` runs.
- Bundled corpora (like `prime-corpus-frontend-design`) ship their own `domain.yaml` files in a `domains/` subdirectory. Users can edit, disable, or replace them like any other config file.
- There is no "built-in vs config" precedence. First registration wins, period.

### Migrating from FRONTEND_DESIGN_DOMAIN (v0.0.x)

If you imported `FRONTEND_DESIGN_DOMAIN` or `createDefaultDomainRegistry` in v0.0.x code:

```typescript
// Before (v0.0.x) — REMOVED
import { FRONTEND_DESIGN_DOMAIN, createDefaultDomainRegistry } from "@prime-lang/runtime";
const registry = createDefaultDomainRegistry();
```

Replace with:

```typescript
// After (v0.1.0+) — load from the corpus's domain.yaml
import { loadDomainFromFile, DomainRegistry, registerAll } from "@prime-lang/runtime";
const registry = new DomainRegistry();
registerAll(registry, [
  loadDomainFromFile("./corpora/frontend-design/domain.yaml"),
]);
```

Or use the convenience factory:

```typescript
import { createConfigDrivenRegistry } from "@prime-lang/runtime";
// Scans for domain.yaml files under cwd/corpora/** (depth ≤ 4)
const registry = createConfigDrivenRegistry();
```

The domain content (tag vocabulary, axes, contract schema) has moved to:
- `prime-corpus-frontend-design/domains/frontend-design.yaml`
- `prime-corpus-frontend-design/domains/security.yaml`
- `prime-corpus-frontend-design/domains/accessibility.yaml`

---

## 3. The `domain.yaml` File

### 3.1 Overview

A domain author creates one `domain.yaml` file per domain. The file lives at the root of the corpus directory, alongside or near the Prime source files.

**Canonical location:**

```
corpora/
  <corpus-name>/
    domain.yaml        ← the config file
    sources/
      @<corpus-name>/
        *.prime
```

A `domain.yaml` file is a YAML document (YAML 1.2) with a fixed top-level structure. All fields are detailed in Section 4.

### 3.2 Minimal Example

The smallest valid `domain.yaml` contains only the three required fields:

```yaml
name: cooking
version: "1.0.0"
description: Domain plugin for cooking knowledge corpora.
```

With only these three fields, the domain registers with an empty tag vocabulary and single `general` axis, and the composition contract defaults to `must_include` + `must_avoid` only. This is sufficient to prevent conflicts with other domains but provides no retrieval bias.

### 3.3 Full Example (Cooking Domain)

```yaml
# corpora/recipes/domain.yaml
name: cooking
version: "1.0.0"
description: Domain plugin for cooking knowledge corpora.

tags:
  - cooking
  - recipe
  - cuisine
  - cook
  - bake
  - simmer
  - braise
  - roast
  - grill
  - season
  - meal-prep
  - technique
  - ingredient
  - temperature
  - flavor
  - fond
  - emulsion
  - maillard
  - mise-en-place

axes:
  - name: cuisine
    description: Regional or stylistic origin (italian, japanese, mexican, ...)
    matches:
      - italian
      - french
      - japanese
      - mexican
      - chinese
      - indian
      - thai
      - mediterranean
      - american
      - korean

  - name: technique
    description: Cooking method applied (braise, sous-vide, grill, ...)
    matches:
      - braise
      - sous-vide
      - grill
      - roast
      - steam
      - poach
      - fry
      - bake
      - smoke
      - deglaze

  - name: skill-level
    description: Intended skill tier of the cook
    matches:
      - beginner
      - easy
      - simple
      - intermediate
      - advanced
      - expert
      - professional

contract:
  must_include:
    type: atom-id-array
    description: Atoms that must appear in the retrieved set.
  must_avoid:
    type: atom-id-array
    description: Atoms that must be excluded from the retrieved set.
  required_techniques:
    type: string-array
    description: Cooking techniques that must be cited by at least one atom.
  dietary_constraints:
    type: enum-array
    values:
      - vegetarian
      - vegan
      - gluten-free
      - dairy-free
      - halal
      - kosher

validators:
  - name: cite-source
    description: Every fact atom must have an attributed_to or source field.
    checker: builtin:every-fact-has-source

  - name: technique-pairs-with-temp
    description: Atoms tagged "braise" must mention a temperature value.
    checker: regex:/(\blow\b|\bmedium\b|\bhigh\b|\d+\s*°[FC])/
```

### 3.4 Full Example (Coding Style Domain)

```yaml
# corpora/coding-style/domain.yaml
name: coding-style
version: "1.0.0"
description: Domain plugin for team coding style and software engineering corpora.

tags:
  - coding-style
  - typescript
  - readability
  - maintainability
  - naming
  - types
  - api-design
  - patterns
  - anti-patterns
  - refactoring
  - testing
  - error-handling
  - team
  - principles
  - linting

axes:
  - name: language
    description: Programming language or ecosystem the atom applies to.
    matches:
      - typescript
      - javascript
      - python
      - go
      - rust
      - java
      - kotlin

  - name: scope
    description: Where in the codebase the guidance applies.
    matches:
      - public-api
      - internal
      - shared-package
      - prototype
      - test

contract:
  must_include:
    type: atom-id-array
    description: Atoms that must appear in the retrieved set.
  must_avoid:
    type: atom-id-array
    description: Atoms that must not appear in output.
  enforcement_level:
    type: enum
    values:
      - error
      - warning
      - suggestion
    description: Minimum enforcement tier for included rules.

validators:
  - name: rule-has-checks
    description: Every rule atom must have a non-empty checks field.
    checker: builtin:rule-has-checks

  - name: anti-pattern-has-solution
    description: Every anti-pattern atom must have a related pattern atom.
    checker: builtin:anti-pattern-has-counterpart
```

---

## 4. Schema Reference

This section is the normative schema definition. Every field is documented with its type, required/optional status, default value, validation rules, and examples.

### 4.1 Top-Level Fields

#### `name`

| Attribute | Value |
|-----------|-------|
| Required | **Yes** |
| Type | `string` |
| Format | kebab-case, 1–64 characters, `[a-z0-9-]+` |
| Default | — |
| Uniqueness | Must be unique across all loaded domains in a single process |

The stable identifier for the domain. Used as the key in `DomainRegistry`, in scope filters, and in atom `domain:` field matching.

**Valid examples:**
```yaml
name: cooking
name: security
name: machine-learning
name: legal-contracts
```

**Invalid examples:**
```yaml
name: Cooking        # uppercase not allowed
name: my_domain      # underscore not allowed
name: ""             # empty string not allowed
```

**Validation rule:** Regex `/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/`

#### `version`

| Attribute | Value |
|-----------|-------|
| Required | **Yes** |
| Type | `string` |
| Format | Semantic version, `MAJOR.MINOR.PATCH` |
| Default | — |

The version of this domain config. Domain configs version independently of the Prime Wiki runtime. Use SemVer: increment PATCH for backward-compatible fixes, MINOR for new optional fields, MAJOR for breaking schema changes.

**Valid examples:**
```yaml
version: "1.0.0"
version: "2.3.1"
```

**Note:** Quoted in YAML to prevent YAML's own number parsing from stripping trailing zeros.

#### `description`

| Attribute | Value |
|-----------|-------|
| Required | **Yes** |
| Type | `string` |
| Length | 1–512 characters |
| Default | — |

A human-readable description of what this domain covers. Shown in CLI output and registry introspection.

```yaml
description: Domain plugin for cooking knowledge corpora.
```

---

### 4.2 `tags`

| Attribute | Value |
|-----------|-------|
| Required | No |
| Type | `string[]` |
| Default | `[]` (empty array) |
| Item format | Unicode letters/digits with optional hyphens; no leading or trailing hyphen; 1–64 chars |
| Tag regex | `^[\p{L}\p{N}][\p{L}\p{N}-]{0,62}[\p{L}\p{N}]$\|^[\p{L}\p{N}]$` (with `/u` flag) |

The canonical tag vocabulary for the domain. Used in two ways:

1. **Brief-domain detection:** The MCP server scans a user's brief for any word matching a domain's tag vocabulary. If a match is found, atoms in that domain receive a retrieval score boost.
2. **Scope check:** An atom's `tags:` field is checked against this vocabulary to determine domain membership for heuristic runs.

**Unicode tag policy:**

Tags accept any Unicode letters and digits (Latin, CJK, Japanese, Greek, Cyrillic, etc.). The tag regex uses the Unicode property escapes `\p{L}` (letter) and `\p{N}` (digit) with the `/u` flag. Tags are stored verbatim as authored.

For brief-to-domain matching:
- ASCII tags are matched case-insensitively: both sides are lowercased before comparison.
- Non-ASCII tags are matched using literal comparison against the lowercased tag vocabulary. Authors should store non-ASCII tags in their canonical lowercase form.

**Guidance for authoring tags:**
- Include the most specific terms a user would naturally write when describing work in this domain.
- Include common synonyms and shorthand.
- Do NOT include generic words — they cause false positive domain matches.
- Aim for 10–40 tags for good coverage without over-matching.

```yaml
tags:
  - cooking
  - recipe
  - bake
  - mise-en-place
  - 烹饪
```

**Validation rules:**
- Each tag must match the Unicode tag regex above
- Maximum 200 tags per domain
- Duplicate tags within one domain: warning (not error), first occurrence kept

---

### 4.3 `axes`

| Attribute | Value |
|-----------|-------|
| Required | No |
| Type | `AxisDef[]` |
| Default | `[{ name: "general", description: "Default retrieval axis", matches: [] }]` |

Retrieval axes are domain-specific dimensions of a brief. When the MCP server parses a brief, it scores each registered axis by counting how many of the axis's `matches` appear in the brief. Axes with high scores drive the retrieval to weight atoms that match those dimensions.

If `axes` is omitted, the domain registers with a single `general` axis that matches all atoms equally.

#### `axes[].name`

| Attribute | Value |
|-----------|-------|
| Required | **Yes** (within axis object) |
| Type | `string` |
| Format | kebab-case, 1–64 characters |

Stable identifier for the axis. Referenced in retrieval logs and debug output.

#### `axes[].description`

| Attribute | Value |
|-----------|-------|
| Required | **Yes** (within axis object) |
| Type | `string` |
| Length | 1–256 characters |

Human-readable description shown in `prime domains --verbose`.

#### `axes[].matches`

| Attribute | Value |
|-----------|-------|
| Required | **Yes** (within axis object) |
| Type | `string[]` |
| Minimum items | 1 |
| Maximum items | 500 |
| Item format | Non-empty string, any casing (matched case-insensitively) |

Words or phrases that, when found in a brief, contribute to the axis score. Matching is substring-based and case-insensitive.

**Unknown axis fields** (fields beyond `name`, `description`, `matches`) are tolerated for forward compatibility. They are silently ignored with a debug-level log message.

---

### 4.4 `contract`

| Attribute | Value |
|-----------|-------|
| Required | No |
| Type | `ContractSchema` (object) |
| Default | `{ must_include: { type: "atom-id-array" }, must_avoid: { type: "atom-id-array" } }` |

The composition contract schema declares what fields are valid in a retrieval call's `contract:` block when targeting this domain. Every domain implicitly has `must_include` and `must_avoid` fields. The `contract:` block in `domain.yaml` adds domain-specific fields on top of that.

#### Contract Field Types

Each key under `contract:` is a contract field definition:

```yaml
<field-name>:
  type: <type>          # Required
  description: <string> # Optional
  values: [...]         # Required only when type = enum or enum-array
```

**Supported types:**

| Type | Description |
|------|-------------|
| `atom-id-array` | Array of atom IDs (`@scope/name`) |
| `string-array` | Array of plain strings |
| `enum` | Single value from a fixed list |
| `enum-array` | Array of values from a fixed list |
| `string` | Single plain string |
| `boolean` | True/false flag |

---

### 4.5 `validators`

| Attribute | Value |
|-----------|-------|
| Required | No |
| Type | `ValidatorDef[]` |
| Default | `[]` (no extra validators) |

Validators are domain-specific output checks intended to run after retrieval.

> **v0.1.0 status:** Validators declared in `domain.yaml` are parsed and stored
> by the runtime, but the execution engine (`@prime-lang/validator-core`) is not
> yet shipped. All `builtin:` and `regex:` validators are silently no-ops in
> v0.1.0. Authors may declare them today to future-proof their configuration;
> the runner will be wired in v0.2. No error or warning is emitted when a
> validator would have fired.

#### `validators[].checker`

Two checker forms will be supported when the v0.2 validator runner ships:

**Builtin checkers** (`builtin:<name>`) — parsed but not executed in v0.1.0:

| Checker name | Planned description |
|---|---|
| `builtin:every-fact-has-source` | Fails if any atom with kind `fact` lacks a `source` or `attributed_to` field |
| `builtin:rule-has-checks` | Fails if any atom with kind `rule` has an empty or missing `checks` field |
| `builtin:anti-pattern-has-counterpart` | Fails if any `anti-pattern` atom has no `related` atom of kind `pattern` |

**Regex checkers** (`regex:<pattern>`) — regex is compiled at load time (syntax errors warn and skip); matching logic is not yet executed:

```yaml
validators:
  - name: technique-pairs-with-temp
    description: Atoms tagged "braise" must mention a temperature.
    checker: regex:/(\blow\b|\bmedium\b|\bhigh\b|\d+\s*°[FC])/
```

The regex is compiled once at load time. Invalid regex causes a load warning and the validator is skipped. In v0.1.0 valid regex validators are stored but never run.

---

## 5. Discovery Mechanism

### 5.1 Startup Scan

The `prime` CLI and MCP server scan for `domain.yaml` files at startup using the following algorithm:

```
1. Determine the search root:
   a. If PRIME_DOMAINS_DIR is set, use that path as the search root.
   b. Otherwise, use the current working directory.

2a. If PRIME_DOMAINS_DIR is set:
    Find all files matching: <PRIME_DOMAINS_DIR>/*/domain.yaml
    (one level deep — simple directory layout, no recursion)

2b. If PRIME_DOMAINS_DIR is NOT set:
    Recursively walk <cwd> looking for any domain.yaml,
    stopping at MAX_DISCOVERY_DEPTH = 4 levels below the root.
    node_modules/ and hidden directories (name starts with ".") are skipped.

3. Sort discovered paths lexicographically (deterministic across runs).

4. For each found file, in lexicographic order:
   a. Parse the YAML.
   b. Validate against the DomainConfig Zod schema.
   c. Convert to a DomainPlugin object.
   d. If the domain name was already seen: log a warning and skip (first-wins).
   e. Otherwise: add to the results.
   f. On hard error: log a warning and skip the file. Do not abort startup.

5. The returned plugins are registered via registerAll() into DomainRegistry.
```

### 5.2 MAX_DISCOVERY_DEPTH

```typescript
export const MAX_DISCOVERY_DEPTH = 4;
```

This constant limits how many directory levels below the root the recursive scan descends. At depth 0 the root itself is scanned; at depth 4 the scanner will descend up to `root/a/b/c/d/`. This prevents expensive scans of deeply nested monorepos while still finding domain.yaml at typical corpus layouts:

| Depth | Example path |
|-------|--------------|
| 0 | `./domain.yaml` |
| 1 | `./corpora/domain.yaml` |
| 2 | `./corpora/recipes/domain.yaml` (most common) |
| 3 | `./packages/corpus/src/domain.yaml` |
| 4 | `./packages/corpus/src/data/domain.yaml` |

### 5.3 Environment Variable Override

```
PRIME_DOMAINS_DIR=/path/to/my/corpora prime query "..."
```

When `PRIME_DOMAINS_DIR` is set:
- The scan root becomes `$PRIME_DOMAINS_DIR` directly.
- The glob applied is `*/domain.yaml` relative to `PRIME_DOMAINS_DIR` (one level, no recursion).
- This allows teams to maintain domain configs in a non-standard directory layout.

### 5.4 Registration Order and Conflict Handling

- Files are loaded in lexicographic path order (deterministic across runs).
- If two `domain.yaml` files declare the same `name`, the **first one wins** and the second is rejected with a warning logged to stderr:

```
[prime-domain] WARN duplicate domain "frontend-design": keeping /path/alpha/domain.yaml, ignoring /path/beta/domain.yaml
```

- There is no concept of "built-in vs config" precedence — that distinction no longer exists. The first domain.yaml file encountered in lexicographic order for a given name is the one that registers.

### 5.5 Graceful Degradation

A malformed `domain.yaml` does NOT crash the process. The loader logs a structured warning:

```
[prime-wiki] WARN: skipped domain.yaml at corpora/my-domain/domain.yaml
  reason: Validation error at "name": Expected string, received undefined
```

The system continues loading other domains. Queries still work; they just won't have the domain's retrieval bias.

---

## 6. Unicode Tag Policy

Tags accept any Unicode letters and digits, not just ASCII. This supports multilingual corpora where tag vocabularies are naturally expressed in the corpus's own language.

**Tag validation regex (normative):**

```
/^[\p{L}\p{N}][\p{L}\p{N}-]{0,62}[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u
```

**Examples of valid tags:**

```yaml
tags:
  - cooking       # ASCII
  - 烹饪           # Chinese
  - αβγ           # Greek
  - スケ            # Japanese
  - cuisine       # French loanword (ASCII)
```

**Brief-to-domain matching behavior:**

| Tag type | Matching |
|----------|---------|
| ASCII-only | Case-insensitive: `WCAG` matches `wcag` |
| Non-ASCII | Literal: `烹饪` only matches `烹饪` (not `COOKING`) |

Authors of non-ASCII tags should store them in the form users would naturally type in briefs.

**No normalize-to-ASCII:** Tags are stored verbatim. There is no transliteration or normalization to ASCII. If you want both `sauté` and `saute` to match, list both in `tags`.

---

## 7. Runtime Integration

### 7.1 How Retrieval Uses the Config

After startup, `DomainRegistry` holds the full set of registered `DomainPlugin` objects, all loaded from `domain.yaml` files. The registry is used identically regardless of which file a plugin came from.

#### Tag-Based Brief Detection

```typescript
// MCP server (pseudo-code showing the contract)
const briefDomains = detectBriefDomains(brief, features);
// For each domain d in briefDomains, atoms with d in their domain: field
// receive a retrieval score boost.
```

`detectBriefDomains` iterates over all registered plugins and checks `plugin.tags` against the brief text.

#### Multi-Axis Scoring

```typescript
for (const axis of plugin.axes) {
  const axisScore = axis.matches.filter(m =>
    briefText.toLowerCase().includes(m.toLowerCase())
  ).length;
}
```

### 7.2 Extended Plugin Fields

The `DomainPlugin` object produced by `loadDomainFromFile` carries additional fields beyond the base interface:

```typescript
interface LoadedDomainPlugin extends DomainPlugin {
  readonly version: string;
  readonly description: string;
  readonly axes: ReadonlyArray<AxisDef>;
  readonly contract: ContractSchema;
  readonly validators: ReadonlyArray<ValidatorDef>;
  readonly sourceFile: string;  // absolute path to the domain.yaml
}
```

Check `'sourceFile' in plugin` to narrow to this type.

---

## 8. Spec Versioning

### 8.1 Spec Change Policy

| Change Type | Spec Version Bump | Backward Compatible? |
|---|---|---|
| Add a new optional field | MINOR (0.1.0 → 0.2.0) | Yes |
| Change an existing field's type | MAJOR (0.x → 1.0.0) | No |
| Remove a field | MAJOR | No |
| Add a new builtin checker | MINOR | Yes |
| Change tag matching semantics | MAJOR | No |
| Add a new contract field type | MINOR | Yes |

### 8.2 Unknown Fields Policy (Forward Compatibility)

The v0.1.0 loader uses `z.object({...}).strip()` (Zod's default), not `.strict()`. Unknown top-level fields in `domain.yaml` are stripped and ignored. This ensures that a `domain.yaml` authored for spec v0.2.0 loads without error in a v0.1.0 runtime.

---

## 9. Security Considerations

### 9.1 Regex Validators

User-supplied regex patterns are compiled at load time. A malformed or pathological regex (ReDoS) could cause the validator compilation to fail or, if it compiles, cause catastrophic backtracking at runtime. The loader:

1. Compiles the regex at load time and catches `SyntaxError`.
2. Does NOT attempt to detect ReDoS patterns (this is out of scope for v0.1.0).

**Recommendation:** Avoid using quantifier-on-quantifier patterns (e.g., `(a+)+`) in `checker: regex:` values.

### 9.2 YAML Parsing

The `yaml` package (v2) does NOT execute arbitrary code during YAML parsing. YAML 1.2 is a data-only format.

### 9.3 Path Traversal

The `discoverDomains` function resolves paths using Node's `path.resolve` and validates that each discovered path is a child of the search root. Files outside the search root are rejected. This prevents a symlink attack from loading a `domain.yaml` outside the corpus directory.

---

## 10. Future Extensions Explicitly Out of Scope (v0.1.0)

### 10.1 Custom Atom Kinds

**Not in v0.1.0.** The 28 built-in kinds are hardcoded in the Prime DSL grammar.

**Future hook:** A `kinds:` top-level field in `domain.yaml` is reserved.

### 10.2 Custom Edge Verbs

**Not in v0.1.0.** The 14 built-in edge verbs are hardcoded.

**Future hook:** A `verbs:` field is reserved in the schema.

### 10.3 LLM-Judge Validators

**Not in v0.1.0.** The `checker` field supports only `builtin:*` and `regex:*` forms.

**Future hook:** `checker: llm:<prompt-template-id>` is the planned syntax.

### 10.4 Cross-Domain Composition

**Not in v0.1.0.** A single retrieval call targets exactly one domain.

### 10.5 Domain Inheritance

**Not in v0.1.0.** A domain cannot declare `extends: another-domain`.

**Future hook:** A top-level `extends: <domain-name>` field is reserved.

### 10.6 Dynamic Hot Reload

**Not in v0.1.0.** The MCP server scans `domain.yaml` files once at startup.

**Future hook:** A future version may add file-watch-based hot reload using `PRIME_WATCH_DOMAINS=1`.

### 10.7 Explicit CLI Flag for Domains Dir

**Not in v0.1.0.** Future spec version: `--domains-dir <path>` CLI flag as an alternative to the env var.

---

## 11. Glossary

| Term | Definition |
|------|------------|
| Domain | A subject-matter area (cooking, security, legal, etc.) that a corpus covers. |
| DomainPlugin | The runtime object in `DomainRegistry` that represents a loaded domain. |
| domain.yaml | The config file that describes a domain. One file per corpus directory. |
| Tag vocabulary | The list of strings in `tags:` used for brief-scanning and scope checks. |
| Retrieval axis | A named dimension of a brief (e.g., cuisine type, skill level) that biases retrieval. |
| Composition contract | A set of requirements (must_include, must_avoid, domain-specific fields) passed to a retrieval call. |
| Validator | A post-retrieval check that verifies domain-specific quality rules. |
| Builtin checker | A validator implementation shipped with the Prime runtime, referenced by name. |
| Regex checker | A validator implementation that matches atom text against a regular expression. |
| scope check | The `scopeCheck(ast)` function on a `DomainPlugin` that returns true if an atom belongs to the domain. |
| Discovery | The process of scanning the filesystem for `domain.yaml` files at startup. |
| DomainRegistry | The in-memory map of domain name to DomainPlugin, keyed by domain name. |
| MAX_DISCOVERY_DEPTH | The maximum number of directory levels below the root that discovery will descend (= 4). |

---

## Appendix A: Complete Zod Schema (Normative)

The canonical schema is implemented in `packages/runtime/src/domain-config.ts`. The TypeScript Zod schema below is reproduced here as a normative reference:

```typescript
import { z } from "zod";

// Unicode-aware tag regex: accepts any script's letters and digits + hyphens
const TAG_REGEX = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,62}[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u;

const AxisDefSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}([a-z0-9])?$|^[a-z0-9]$/),
  description: z.string().min(1).max(256),
  matches: z.array(z.string().min(1)).min(1).max(500),
}).passthrough();  // unknown fields tolerated (forward compat)

const ContractFieldTypeSchema = z.enum([
  "atom-id-array",
  "string-array",
  "enum",
  "enum-array",
  "string",
  "boolean",
]);

const ContractFieldSchema = z.object({
  type: ContractFieldTypeSchema,
  description: z.string().optional(),
  values: z.array(z.string()).optional(),
}).passthrough();

const ValidatorDefSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  checker: z.string().min(1),
}).passthrough();

const DomainConfigSchema = z.object({
  name: z.string().regex(
    /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/,
    "name must be kebab-case, 1–64 chars"
  ),
  version: z.string().regex(
    /^\d+\.\d+\.\d+$/,
    "version must be semver (MAJOR.MINOR.PATCH)"
  ),
  description: z.string().min(1).max(512),
  tags: z.array(z.string().regex(TAG_REGEX)).max(200).default([]),
  axes: z.array(AxisDefSchema).default([]),
  contract: z.record(z.string(), ContractFieldSchema).default({}),
  validators: z.array(ValidatorDefSchema).default([]),
});
```

---

## Appendix B: Example Directory Layout

```
my-project/
  corpora/
    recipes/
      domain.yaml          ← loaded by prime at startup (depth 2)
      sources/
        @recipes/
          fact-maillard-reaction-temperature.prime
          method-pan-sauce.prime
          rule-rest-meat-after-cooking.prime
    legal/
      domain.yaml          ← second domain, loaded after recipes/
      sources/
        @legal/
          principle-plain-language.prime
          rule-statute-citation.prime
  CLAUDE.md
```

When `prime query "how do I make a pan sauce"` runs from `my-project/`, it loads both domains and returns cooking-biased results. When asked `"cite-style for judicial opinions"`, it returns legal-biased results.

### Corpus package with domains/ subdirectory

```
prime-corpus-frontend-design/
  domains/
    frontend-design.yaml   ← loaded at depth 2 below the corpus root
    security.yaml
    accessibility.yaml
  primes-v3/
    sources/
      ...
```

---

*End of DOMAIN-EXTENSION-SPEC v0.2.0*
