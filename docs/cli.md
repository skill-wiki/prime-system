# `prime` — CLI reference

The `prime` CLI is a single binary that compiles `.prime` corpora, inspects
the resulting atoms, and pushes/pulls them across registries. There are no
plugins, no subshell modes — every verb runs and exits.

```bash
prime --version
# prime v0.1.0
```

This page documents every shipping verb. Verbs that exist in `--help` but
have planned-not-built behavior are called out explicitly.

---

## Verb table

| Group | Verb | One-line |
|---|---|---|
| Build | `init`, `compile`, `check` | scaffold, parse + emit, validate |
| Inspect | `list`, `show`, `graph`, `deps`, `search`, `info`, `ls` | read the corpus |
| Package | `install`, `publish` | move atoms across registries |
| Authoring | `decompose` | heuristic Skill → Primes (see caveats) |
| Test | `test` | structural check on `success_criteria` blocks |

The remainder of the page goes group by group with **synopsis · example
invocation · sample output · exit codes**. All output strings are exactly
what the CLI prints today (verified against `packages/cli/src/commands/`).

---

## Build commands

### `prime init [name]`

Scaffold a new `.prime` source file in the current directory. Interactive
unless `name` is passed; the second prompt picks the base class
(`Knowledge` / `Method` / `Rule`).

```bash
$ prime init persona-stripe
Type — (K)nowledge, (M)ethod, or (R)ule? [M]: K
Description: Stripe-style warm institutional register
Tags (comma-separated): register, warm-institutional, b2b

✅  Created persona-stripe.prime

  Next steps:
  1. Edit persona-stripe.prime to fill in content
  2. Run prime compile persona-stripe.prime to check and compile
  3. Run prime publish to share on prime.dev
```

Exit codes: `0` success · `1` file already exists.

### `prime compile <file.prime> [--deep] [--output <dir>] [--bundle] [--dir]`

Run all four phases — Parse → Check (L1, optionally L2/L3) → Resolve →
Emit. Default emit produces `<name>.md`, `<name>.index.yaml`,
`<name>.graph.yaml` in `./compiled/`. `--dir` switches to the **atom
directory** layout (one folder per atom with `summary.md` / `core.md` /
`full.md` projections plus a top-level `_index.xml`).

```bash
$ prime compile primes/persona-stripe.prime --dir
═══ Prime Compiler v0.1
   Compiling: persona-stripe.prime

✅ Phase 1: Parsed 184 lines, 0 syntax errors
✅ Phase 2: All checks passed
✅ Phase 3: 0 dependencies resolved
✅ Phase 4: Emitted atom directory

✅  compiled/@community/persona-stripe
    → summary.md
    → core.md
    → full.md
✅  compiled/_index.xml

  Tokens: summary=24 core=146 full=412

  Result: 0 errors, 0 warnings, 0 suggestions. Compilation successful.
```

Flags:

| Flag | Effect |
|---|---|
| `--deep` | Run L2 + L3 semantic checks (requires `DEEPSEEK_API_KEY`; otherwise gracefully skipped). |
| `--structure-only` | L1 only — fastest. |
| `--output <dir>` | Override emit dir (default `<sourceDir>/compiled`). |
| `--dir` | Atom-directory layout (recommended). |
| `--bundle` | Also emit `<name>.bundle.md` with transitive deps inlined. Legacy flat mode only. |

Exit codes: `0` success · `1` parse / check / resolve error.

### `prime check <file>`

Validate a `.prime` source file (or a `SKILL.md`) without emitting any
output. Useful as a fast pre-commit gate.

```bash
$ prime check primes/persona-stripe.prime
═══ Prime Check — persona-stripe.prime
✅  All checks passed
```

```bash
$ prime check broken.prime
═══ Prime Check — broken.prime
❌  2 errors, 1 warnings
  ✕ error  Method missing input declaration
  ✕ error  Method missing output declaration
  ⚠ warn   Step 'BoilWater' has no error handler. Add error: or mark @safe
```

For an existing `SKILL.md` it heuristically suggests Prime extraction
when the file is large or referenceless.

There is also a registry-wide variant:

```bash
$ prime check --registry --dir primes-v3/sources
═══ Prime Registry — Integrity Check

  Atoms checked:   899
  Passed:          896
  With issues:     3
  Pass rate:       99%

  Errors  (3 atoms)
  ───────────────────────────────────────────────────────
  · @community/method-onboarding-flow
      ✕ must-include: '@community/pattern-bedrock-step' not found
```

Exit codes: `0` clean · `1` errors found.

---

## Inspection commands

### `prime list [--scope @s] [--dir <path>] [--json]`

Walk the sources tree and print every atom grouped by scope. Reads from
`packages/cli/src/commands/registry.ts`'s `DEFAULT_SOURCES_DIR`; override
with `--dir`.

```bash
$ prime list --scope @community
═══ Prime Registry — 84 atoms across 1 scope(s)

  @community  (84 atoms)
  ──────────────────────────────────────────────────
  · persona            @community/persona-stripe
  · persona            @community/persona-linear
  · pattern            @community/pattern-bedrock-step
  · check              @community/check-contrast-aaa
  · …
```

`--json` emits `{ "@community": ["@community/persona-stripe", ...] }` for
piping into other tools.

### `prime show <@scope/name> [--json] [--dir <path>]`

Print one atom: id, kind, version, scope, file, description, then each
edge group.

```bash
$ prime show @community/persona-stripe
═══ @community/persona-stripe  (persona)

  version     1.0.0
  kind        persona
  scope       @community
  file        /…/sources/@community/persona-stripe.prime

  description
    Warm institutional B2B register — restrained color, generous
    type, narrative captions, tasteful gradients.

  must-include  (4)
    + @community/rule-contrast-aaa
    + @community/pattern-card-elevated
    + …

  must-avoid    (2)
    ✕ @community/anti-pattern-rainbow-gradient
    ✕ @community/persona-brutalist
```

Exit codes: `0` found · `1` atom not in sources dir.

### `prime graph <file.prime> [--format ascii]`

Render the relationship graph for **one source file** as ASCII.

```bash
$ prime graph primes/persona-stripe.prime
═══ Relationship Graph: persona-stripe.prime

  ┌──────────────────────┐
    │  persona-stripe  │
  └──────────────────────┘
  ├── REQUIRES ──→ rule-contrast-aaa
  ├── ENHANCES - -→ pattern-card-elevated
  ├── CONTRADICTS ──✕ persona-brutalist
  └── VALIDATES ──→ check-color-tokens

  Legend: ──→ required  - -→ optional  ──✕ contradicts
```

Note: `--format svg` is documented in `--help` but not implemented;
ASCII is the only renderer in v0.1.

### `prime deps <@scope/name> [--depth N] [--related] [--json]`

Recursively walk **must-include · motion-prescriptions · must-avoid**
edges from a compiled atom (defaults to depth 3). `--related` opts in
to `related` edges too — without it they're listed flat at depth 0.

```bash
$ prime deps @community/persona-stripe --depth 2
Dependency tree  (depth ≤ 2)
Legend:  + must-include   ~ motion   · related   ✕ must-avoid

@community/persona-stripe  (persona)
├── + @community/rule-contrast-aaa  (rule v1.0.0)
│   └── + @community/term-luminance  (term v1.0.0)
├── ~ @community/motion-soft-spring  (template v1.0.0)
├── · @community/pattern-card-elevated  (pattern v1.0.0)
└── ✕ @community/persona-brutalist  (persona v1.0.0)
```

`--json` emits a flat adjacency-list keyed by atom id — convenient for
piping into `jq`.

### `prime search <query> [--type T] [--tag X]`

Hits `https://prime.dev/api/search` first; on failure falls back to a
local fuzzy search across `primes/` and `.primes/source/`. Local-only
behavior is honest about being offline:

```bash
$ prime search contrast --tag a11y
  Registry unavailable. Searching local primes...

  rule-contrast-aaa  rule  ★★★★★  0 uses
  WCAG 2.1 AAA contrast — 7:1 normal, 4.5:1 large.

  (local results only — registry unavailable)
```

### `prime info <name>`

Print one atom's metadata; tries local first, then `prime.dev/api/primes/<name>`.
Includes a tokens-saved estimate if the atom has been compiled.

```bash
$ prime info persona-stripe
═══ persona-stripe
  knowledge | v1.0.0 | MIT
  Warm institutional B2B register — restrained color, generous type.

  Author:  @community
  Tags:    register, warm-institutional, b2b
  Source:  /Users/.../primes/persona-stripe.prime
  Compiled: ✅ (1240 → 412 tokens, 67% reduction)

  Links:
    requires → rule-contrast-aaa
    enhances → pattern-card-elevated
    contradicts → persona-brutalist
```

### `prime ls`

List atoms installed under `.primes/source/` (the project-local install
target). Uses a different lookup root from `prime list` — `ls` is
"what's installed for this project", `list` is "what exists in the
sources tree". Run `prime install` first or you'll see:

```bash
$ prime ls
  No primes installed.
```

After install:

```bash
$ prime ls
═══ Installed Primes

  Name              Type        Version  Compiled?
  persona-stripe    knowledge   1.0.0    ✅
  rule-contrast-aaa rule        1.0.0    —

  2 primes installed in /Users/.../.primes
```

---

## Package commands

### `prime install <@scope/name | name> [--remote URL] [--dir <path>] [--no-related] [--no-fetch] [--json]`

Two modes, picked by the shape of the first argument:

**Local resolve mode** (when arg starts with `@`, the modern path):
walks dependency edges and verifies every reference is on disk. Without
`--remote`, missing refs are listed as errors.

```bash
$ prime install @community/persona-stripe
═══ prime install @community/persona-stripe
  file     /…/sources/@community/persona-stripe.prime
  version  1.0.0
  deps checked  17

  ✅  Resolved — all 17 dependency references found.

  Local-only install. To fetch from a remote registry:
    prime install @community/persona-stripe --remote https://registry.example.com
    (or set PRIME_REGISTRY env var)
```

**Remote-fetch mode** (`--remote URL` or `PRIME_REGISTRY` env): for
every missing dep, GETs `<url>/atoms/<id>.prime` and writes it under
`<dir>/<scope>/`. Recurses on the new atom's deps.

```bash
$ PRIME_REGISTRY=http://localhost:7700 prime install @community/persona-stripe --dir /tmp/dest
  fetched  3 from http://localhost:7700
    + @community/persona-stripe
    + @community/rule-contrast-aaa
    + @community/pattern-card-elevated

  ❌  2 missing references:
    · @community/term-luminance
    · @community/motion-soft-spring

  ⚠  2 atoms returned 404 from registry
```

**Legacy mode** (when arg doesn't start with `@` and isn't a flag):
delegates to the original install path which calls `prime.dev/api/primes/<name>/download`
and writes to `.primes/source/<name>.prime`. The legacy mode also picks
up an undeclared `prime install` (no args) which reads `SKILL.md` for a
`primes:` block.

Exit codes: `0` resolved · `1` missing deps or atom not found.

### `prime publish [<file.prime>] [--remote URL] [--dry-run]`

PUTs the source file to `<remote>/atoms/<id>.prime`. The registry URL
comes from `--remote` or the `PRIME_REGISTRY` env var. Auth is a Bearer
token from `PRIME_REGISTRY_TOKEN`.

```bash
$ PRIME_REGISTRY=http://localhost:7700 \
  PRIME_REGISTRY_TOKEN=secret \
  prime publish primes/@community/persona-stripe.prime

═══ Publishing persona-stripe.prime
  ✅  Running pre-publish checks...
  ✅  id:      @community/persona-stripe
  ✅  version: 1.0.0
  ✅  kind:    persona

  ⠋ PUT http://localhost:7700/atoms/@community/persona-stripe.prime
  ✅ Published!

  ✅  @community/persona-stripe@1.0.0 now resolvable at
      http://localhost:7700/atoms/@community/persona-stripe.prime
      Try:  prime install @community/persona-stripe --remote http://localhost:7700
```

`--dry-run` skips the network call but still runs the local sanity check
(`id`, `version`, `kind` all present).

Exit codes: `0` 2xx · `1` missing field, network failure, registry
rejection.

---

## Authoring commands

### `prime decompose <SKILL.md> [--extract]`

**Heuristic only**, not LLM-backed. Splits a long SKILL.md by `##`
headings and labels each section as Knowledge / Method / Rule based on
keyword matches (`分类|classification|categories` → knowledge,
`步骤|step|workflow` → method, etc.). Prints a reusability score
(`★★★`/`★★`/`★`) per section. With `--extract`, writes one `.prime`
template per detected component into `./primes/`.

```bash
$ prime decompose ANTHROPIC-IMPECCABLE-SKILL.md
═══ Decompose: ANTHROPIC-IMPECCABLE-SKILL.md
  Analyzing 487 lines...

  Knowledge (语义层 — 是什么):
  ──────────────────────────────────────────────────
  ◆ design-system-categories
    Design System Categories — extracted classification/taxonomy
    Reusability: ★★★ Classifications are highly reusable across contexts

  Method (动能层 — 怎么做):
  ──────────────────────────────────────────────────
  ◆ design-review-workflow
    Design Review Workflow — extracted workflow/process
    Reusability: ★★ Workflows may need adaptation for different contexts

  Suggested relationships:
    design-review-workflow --REQUIRES--> design-system-categories
    design-review-workflow --VALIDATES--> contrast-quality-check

  Summary: 4 extractable components found
  3 high-reusability (★★★)  1 medium-reusability (★★)  0 low (★)
```

**Honest caveat**: the section labeling is regex on heading text.
For real Skill → atom conversion at quality, a domain-specific
LLM-driven authoring tool (e.g. a `prime-decompose` Skill living
alongside the corpus) is the recommended path. `prime decompose` is
useful for a first pass, not for a final authoring step.

---

## Test commands

### `prime test <file.prime>`

Runs structural checks on `success_criteria` / `failure_criteria` /
`checks` blocks — verifies each criterion has a `verify:`, that
`weight:` values sum to ~1.0 in weighted mode, and that `min_score:`
falls in `[0, 1]`. Does **not** execute the criteria; runtime accuracy
depends on the consuming agent.

```bash
$ prime test primes/method-make-tea.prime
═══ Testing evaluation criteria: method-make-tea.prime

  success_criteria:
    ✅ tea-temperature-correct: verify method exists
    ✅ tea-temperature-correct: decidability marked as @decidable
    ✅ leaves-steeped-3-5min: verify method exists
    ✅ leaves-steeped-3-5min: decidability marked as @decidable
    ✅ weights sum: 1.00 ✓
    ✅ min_score: 0.8 (valid range)

  failure_criteria:
    ✅ water-not-boiling: defined

  Summary:
  6 passed

  All evaluation criteria are structurally valid.
```

Exit codes: `0` all pass · `1` any failure.

---

## Common flag patterns

| Pattern | Verbs | Meaning |
|---|---|---|
| `--src <dir>` / `--dir <dir>` | `list`, `show`, `deps`, `install`, `check --registry` | override sources lookup root |
| `--out <dir>` / `--output <dir>` | `compile` | override emit target |
| `--json` | `list`, `show`, `deps`, `install`, `check --registry` | machine-readable output |
| `--remote <url>` | `install`, `publish` | registry base URL (or `PRIME_REGISTRY` env) |
| `--depth <n>` | `deps` | max recursion depth (default 3) |
| `--scope <@s>` | `list`, `check --registry` | filter to one scope |

---

## Environment variables

| Var | Used by | Effect |
|---|---|---|
| `PRIME_REGISTRY` | `install`, `publish` | default remote URL |
| `PRIME_REGISTRY_TOKEN` | `publish` | sent as `Authorization: Bearer <token>` |
| `DEEPSEEK_API_KEY` | `compile --deep` | enables L2/L3 semantic checks |

---

## A real first session — clone to first compiled atom

```bash
# 1. Get the system
$ git clone https://github.com/skill-wiki/prime-system.git
$ cd prime-system && bun install && bun run build

# 2. Verify the binary
$ bun run packages/cli/src/index.ts --version
prime v0.1.0

# 3. Hop into the smallest example
$ cd examples/hello-world

# 4. Inspect what's there
$ prime list --dir primes/sources
═══ Prime Registry — 5 atoms across 1 scope(s)
  @example  (5 atoms)
  · fact      @example/fact-water-boils-at-100c
  · term      @example/term-celsius
  · rule      @example/rule-altitude-affects-boiling
  · method    @example/method-make-tea
  · collection @example/collection-tea-basics

# 5. Compile
$ prime compile primes/sources/@example/fact-water-boils-at-100c.prime --dir
✅ Phase 1: Parsed 18 lines, 0 syntax errors
✅ Phase 2: All checks passed
✅ Phase 4: Emitted atom directory
   Tokens: summary=14 core=42 full=88

# 6. Inspect deps
$ prime deps @example/method-make-tea --dir primes/sources
method-make-tea (method)
├── + fact-water-boils-at-100c
├── + rule-altitude-affects-boiling
└── · term-celsius
```

Six commands, one minute, no API keys.

---

## See also

- `docs/mcp.md` — wiring the compiled corpus into Claude Code via the
  generic MCP server.
- `docs/registry.md` — running your own registry; the `publish`/`install`
  round-trip end-to-end.
- `docs/corpus-authoring.md` — building a corpus from scratch.
- `spec/PRIME-PROTOCOL-v1.md` §3 — formal CLI grammar and exit codes.
