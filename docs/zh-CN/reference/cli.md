# `prime` —— CLI 速查

`prime` 是一个独立二进制：编译 `.prime` corpus、查 atom、在 registry 之间
推拉。没有 plugin，没有交互模式，每个 verb 跑完就退出。

```bash
prime --version
# prime v0.1.0
```

这页把每个 verb 写一遍。`--help` 里有但实际没实现的，会单独点出来。

---

## Verb 总表

| 分组 | Verb | 一句话 |
|---|---|---|
| 构建 | `init`、`compile`、`check` | 起骨架、解析+产物、校验 |
| 查看 | `list`、`show`、`graph`、`deps`、`search`、`info`、`ls` | 读 corpus |
| 包管理 | `install`、`publish` | 在 registry 之间搬 atom |
| 写作 | `decompose` | 启发式 Skill→Primes（看 caveat） |
| 测试 | `test` | 校验 `success_criteria` 块的结构 |

下文按分组写：**用法 · 真实调用 · 真实输出 · exit code**。所有输出
字符串都是直接对着 `packages/cli/src/commands/` 的代码确认过的。

---

## 构建命令

### `prime init [name]`

在当前目录拉一个 `.prime` 模板。不传 `name` 就交互式问；第二个 prompt
选 base class（`Knowledge` / `Method` / `Rule`）。

```bash
$ prime init persona-stripe
Type — (K)nowledge, (M)ethod, or (R)ule? [M]: K
Description: Stripe 风格的 warm institutional register
Tags (comma-separated): register, warm-institutional, b2b

✅  Created persona-stripe.prime

  Next steps:
  1. Edit persona-stripe.prime to fill in content
  2. Run prime compile persona-stripe.prime to check and compile
  3. Run prime publish to share on prime.dev
```

Exit code：`0` 成功 · `1` 文件已存在。

### `prime compile <file.prime> [--deep] [--output <dir>] [--bundle] [--dir]`

跑完整 4 阶段：Parse → Check（默认 L1，`--deep` 加 L2+L3）→ Resolve
→ Emit。默认产出 `<name>.md` + `<name>.index.yaml` + `<name>.graph.yaml`，
都进 `./compiled/`。`--dir` 切到**原子目录**布局：每个 atom 一个文件夹，
里面 `summary.md` / `core.md` / `full.md` 三层投影，外加顶层 `_index.xml`。

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

Flag：

| Flag | 作用 |
|---|---|
| `--deep` | 跑 L2 + L3 语义检查（需要 `DEEPSEEK_API_KEY`，没 key 就静默跳过）。 |
| `--structure-only` | 只跑 L1，最快。 |
| `--output <dir>` | 改 emit 目录（默认 `<sourceDir>/compiled`）。 |
| `--dir` | 切到原子目录布局（推荐）。 |
| `--bundle` | 同时产 `<name>.bundle.md`，把传递依赖 inline 进来；只在传统 flat 模式生效。 |

Exit code：`0` 成功 · `1` parse / check / resolve 任何一个失败。

### `prime check <file>`

不出 emit，只校验。可以收 `.prime` 也可以收 `SKILL.md`。适合做 pre-commit。

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

对 `SKILL.md`，会做启发式建议——比如文件超过 500 行就提醒拆分。

还有一个 registry 级的全量校验：

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

Exit code：`0` 干净 · `1` 有 error。

---

## 查看命令

### `prime list [--scope @s] [--dir <path>] [--json]`

走 sources 树，按 scope 把所有 atom 列出来。默认从
`packages/cli/src/commands/registry.ts` 里的 `DEFAULT_SOURCES_DIR` 读，
要换路径用 `--dir`。

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

`--json` 出 `{ "@community": ["@community/persona-stripe", ...] }`，
方便管道。

### `prime show <@scope/name> [--json] [--dir <path>]`

打印一个 atom：id、kind、version、scope、文件路径、description、然后
按 edge 分组列依赖。

```bash
$ prime show @community/persona-stripe
═══ @community/persona-stripe  (persona)

  version     1.0.0
  kind        persona
  scope       @community
  file        /…/sources/@community/persona-stripe.prime

  description
    Warm institutional B2B register —— 克制的色板、宽裕的字距、
    叙事性 caption、有节制的 gradient。

  must-include  (4)
    + @community/rule-contrast-aaa
    + @community/pattern-card-elevated
    + …

  must-avoid    (2)
    ✕ @community/anti-pattern-rainbow-gradient
    ✕ @community/persona-brutalist
```

Exit code：`0` 找到 · `1` sources 里没这个 atom。

### `prime graph <file.prime> [--format ascii]`

针对**单个源文件**画 ASCII 关系图。

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

注意：`--format svg` 在 `--help` 提到过但 v0.1 没实现，只有 ASCII。

### `prime deps <@scope/name> [--depth N] [--related] [--json]`

从一个 atom 出发，递归走 **must-include · motion-prescriptions ·
must-avoid** 边（默认深度 3）。`--related` 把 `related` 边也走进去；
不加的话，这些 ref 会扁平列在 depth 0。

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

`--json` 出按 atom id 索引的扁平邻接表，给 `jq` 用很方便。

### `prime search <query> [--type T] [--tag X]`

先打 `https://prime.dev/api/search`；网络不行就降级到本地的
`primes/` 和 `.primes/source/` 模糊搜。本地模式自己会标明：

```bash
$ prime search contrast --tag a11y
  Registry unavailable. Searching local primes...

  rule-contrast-aaa  rule  ★★★★★  0 uses
  WCAG 2.1 AAA contrast — 7:1 normal, 4.5:1 large.

  (local results only — registry unavailable)
```

### `prime info <name>`

把一个 atom 的元数据打出来；先查本地，再降级到
`prime.dev/api/primes/<name>`。如果该 atom 编译过，会顺便算一下 token
节省。

```bash
$ prime info persona-stripe
═══ persona-stripe
  knowledge | v1.0.0 | MIT
  Warm institutional B2B register — 克制色板、宽裕字距。

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

列 `.primes/source/` 下面**装在当前项目**的 atom。注意它和
`prime list` 的 lookup root 不一样——`ls` 是「这个项目装了什么」，
`list` 是「sources 树里有什么」。没装过就：

```bash
$ prime ls
  No primes installed.
```

装过之后：

```bash
$ prime ls
═══ Installed Primes

  Name              Type        Version  Compiled?
  persona-stripe    knowledge   1.0.0    ✅
  rule-contrast-aaa rule        1.0.0    —

  2 primes installed in /Users/.../.primes
```

---

## 包管理命令

### `prime install <@scope/name | name> [--remote URL] [--dir <path>] [--no-related] [--no-fetch] [--json]`

按第一个参数的形态分两种模式：

**本地解析模式**（参数以 `@` 开头，新路径）：走依赖边，确认每个引用
都在硬盘上。不加 `--remote` 时，缺的会列成 error。

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

**远端拉取模式**（`--remote URL` 或 `PRIME_REGISTRY` 环境变量）：每个
缺的依赖都 GET `<url>/atoms/<id>.prime`，写到 `<dir>/<scope>/`。新拉
下来的 atom 也会递归处理它的依赖。

```bash
$ PRIME_REGISTRY=http://localhost:7700 \
  prime install @community/persona-stripe --dir /tmp/dest

  fetched  3 from http://localhost:7700
    + @community/persona-stripe
    + @community/rule-contrast-aaa
    + @community/pattern-card-elevated

  ❌  2 missing references:
    · @community/term-luminance
    · @community/motion-soft-spring

  ⚠  2 atoms returned 404 from registry
```

**Legacy 模式**（参数不以 `@` 开头、也不是 flag）：走原本的
`prime.dev/api/primes/<name>/download` 路径，写到 `.primes/source/<name>.prime`。
这条路径还兼容 `prime install`（不带参数）—— 会读 `SKILL.md` 里的
`primes:` 段。

Exit code：`0` 解析通过 · `1` 有缺漏或 atom 找不到。

### `prime publish [<file.prime>] [--remote URL] [--dry-run]`

PUT 源文件到 `<remote>/atoms/<id>.prime`。registry URL 来自 `--remote`
或 `PRIME_REGISTRY` 环境变量；鉴权用 Bearer token，从
`PRIME_REGISTRY_TOKEN` 读。

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

`--dry-run` 跳过网络调用，但本地 sanity check（`id` / `version` /
`kind` 必填）照跑。

Exit code：`0` 服务端 2xx · `1` 缺字段、网络失败、registry 拒绝。

---

## 写作命令

### `prime decompose <SKILL.md> [--extract]`

**纯启发式**，不调 LLM。按 `##` 拆段落，根据标题里的关键字打标
（`分类|classification|categories` → knowledge，
`步骤|step|workflow` → method 等等），再给每段算一个复用度
（`★★★`/`★★`/`★`）。加 `--extract` 会按检测结果在 `./primes/` 里
生成 `.prime` 模板。

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

**老实说**：这个 verb 只看标题正则，不读语义。要把 Skill 高质量
转成 atom，还是建议在 corpus 仓库里另写一个 LLM 驱动的
`prime-decompose` Skill。`prime decompose` 适合做粗筛，不适合做
最终产物。

---

## 测试命令

### `prime test <file.prime>`

对 `success_criteria` / `failure_criteria` / `checks` 块做结构性校验：
每个 criterion 是否有 `verify:`、weighted 模式下 `weight:` 是否凑够
约 1.0、`min_score:` 是否在 `[0, 1]`。**不会真的执行** criterion——
runtime 准确度看消费这个 atom 的 agent。

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

Exit code：`0` 全过 · `1` 有失败。

---

## 通用 flag

| Pattern | 涉及 verb | 含义 |
|---|---|---|
| `--src <dir>` / `--dir <dir>` | `list`、`show`、`deps`、`install`、`check --registry` | 改 sources 根 |
| `--out <dir>` / `--output <dir>` | `compile` | 改 emit 目标 |
| `--json` | `list`、`show`、`deps`、`install`、`check --registry` | 机器可读输出 |
| `--remote <url>` | `install`、`publish` | registry 基地址（或读 `PRIME_REGISTRY`） |
| `--depth <n>` | `deps` | 最大递归深度（默认 3） |
| `--scope <@s>` | `list`、`check --registry` | 只看一个 scope |

---

## 环境变量

| 变量 | 谁用 | 作用 |
|---|---|---|
| `PRIME_REGISTRY` | `install`、`publish` | 默认 remote URL |
| `PRIME_REGISTRY_TOKEN` | `publish` | 作为 `Authorization: Bearer <token>` 发送 |
| `DEEPSEEK_API_KEY` | `compile --deep` | 启用 L2/L3 语义校验 |

---

## 一次完整 first session：clone 到第一个编译完的 atom

```bash
# 1. 拿系统
$ git clone https://github.com/skill-wiki/prime-system.git
$ cd prime-system && bun install && bun run build

# 2. 看二进制能跑
$ bun run packages/cli/src/index.ts --version
prime v0.1.0

# 3. 进最小 example
$ cd examples/hello-world

# 4. 看里面有啥
$ prime list --dir primes/sources
═══ Prime Registry — 5 atoms across 1 scope(s)
  @example  (5 atoms)
  · fact      @example/fact-water-boils-at-100c
  · term      @example/term-celsius
  · rule      @example/rule-altitude-affects-boiling
  · method    @example/method-make-tea
  · collection @example/collection-tea-basics

# 5. 编译
$ prime compile primes/sources/@example/fact-water-boils-at-100c.prime --dir
✅ Phase 1: Parsed 18 lines, 0 syntax errors
✅ Phase 2: All checks passed
✅ Phase 4: Emitted atom directory
   Tokens: summary=14 core=42 full=88

# 6. 看依赖
$ prime deps @example/method-make-tea --dir primes/sources
method-make-tea (method)
├── + fact-water-boils-at-100c
├── + rule-altitude-affects-boiling
└── · term-celsius
```

6 条命令，1 分钟，0 个 API key。

---

## 相关

- `docs/zh-CN/mcp.md` —— 把编译好的 corpus 接进 Claude Code（通用 MCP）。
- `docs/zh-CN/registry.md` —— 自托管 registry，`publish`/`install` 全链路。
- `docs/zh-CN/corpus-authoring.md` —— 从零起一个 corpus。
- `spec/PRIME-PROTOCOL-v1.md` §3 —— 形式化 CLI 语法和 exit code。
