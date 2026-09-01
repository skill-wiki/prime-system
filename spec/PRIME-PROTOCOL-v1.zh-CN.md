# Prime 协议 — v1.0

> AI 知识的协议层：类型化原子、边图、投影层级、组合约束、语料库注册中心。

**状态**：稳定——v1.0，冻结于 2026-05-09。
**领域**：通过 `domain.yaml` 插件化——协议本身不内置任何领域。

> **优先阅读本文件。** 如果你正在构建领域专用包装器（例如前端设计 MCP 或安全策略顾问），先在此了解通用协议，再阅读 [`spec/FRONTEND-DESIGN-DOMAIN-v1.zh-CN.md`](./FRONTEND-DESIGN-DOMAIN-v1.zh-CN.md) 了解附带的前端设计参考实现。领域扩展机制参见 [`spec/DOMAIN-EXTENSION-SPEC.zh-CN.md`](./DOMAIN-EXTENSION-SPEC.zh-CN.md)。

---

## §1 · 原子 DSL 语法

### 原子声明

```
<kind> <PascalName> {
  id: "@<scope>/<kebab-name>"
  version: "<semver>"
  description: "..."

  // 类型专属字段（见 §1.2）...

  related: [@scope/atom, ...]
  composition: {
    must-include: [@scope/atom, ...]
    must-avoid:   [@scope/atom, ...]
    // 领域专属子字段（如 typography-required、motion-prescriptions）
    // 由领域语料库原子定义，由领域工具解析。
    // 不属于协议本身。
  }
}
```

**`composition:`** 对任意原子类型均可用——不仅限于 `persona` 或 `pattern`。协议将 `must-include` 和 `must-avoid` 定义为通用字段。领域通过其 `domain.yaml` 的 `contract:` 块添加类型化子字段（见 DOMAIN-EXTENSION-SPEC §3）。

### §1.1 · 支持的字段类型

| 类型语法 | 示例 |
|---|---|
| 字符串字面量 | `"Fraunces"` |
| 管道块（`\|`） | 多行字符串，保留换行 |
| 三引号字符串 | `"""..."""` |
| 数组 | `["a", "b", "c"]` |
| 连字符关键字字段 | `font-display: "..."` |
| 函数签名 | `(input: AtomList) -> CompositionResult` |
| 联合类型 | `"low" \| "med" \| "high"` |
| 范围表达式 | `0.0-1.0` |
| 原始表达式（兜底） | 不匹配上述任何形式的值 |

解析器：`packages/parser/src/{lexer,parser,errors}.ts`。62 个解析器测试在 `node --experimental-transform-types` 下全部通过。

### §1.2 · 28 种原子类型（5 层）

**数据层** — 什么是真的 / 事物是什么：
- `fact` — 有置信度和来源的实证性断言
- `term` — 概念定义
- `value` — 具名的类型化值（数字、布尔或任意标量）
- `category` — 分类法中的类别
- `example` — 正面示例
- `counter-example` — 反例，展示不应做什么
- `source` — 可引用的参考文献（论文、规范、指南）
- `metric` — 可测量的阈值或基准

**行为层** — 能做什么：
- `step` — 序列中的离散操作
- `check` — 对产物的通过/失败断言
- `transform` — 从一种形式到另一种形式的映射
- `tool` — 具名的软件工具或 API
- `method` — 有输入/输出的多步骤过程

**组合层** — 如何组装事物：
- `rule` — 规范性约束（"始终 X"、"绝不 Y"）
- `taxonomy` — 分类层次结构
- `pattern` — 有变体的可复用结构模式
- `anti-pattern` — 应主动避免的模式
- `type` — 结构类型定义

**风格 / 参数层** — 姿态与声音参数：
- `persona` — 一种连贯的立场 / 视角原子：一种具名的视角，其他原子引用它以对齐风格或方法论。示例：设计 `persona`（"stripe-clean"）、安全 `persona`（"threat-modeller"）、烹饪 `persona`（"classical-french"）。
- `voice` — 写作风格或语调约定
- `constraint` — 不可覆盖的硬性限制
- `template` — 可复用模板（标记、文档、流程、配方——内容由领域决定）
- `provocation` — 对正统观念的刻意挑衅

**元层** — 知识组织：
- `collection` — 可发布的原子集合（映射为一个 Skill）
- `scope` — 定义具名的命名空间边界
- `tradeoff` — 两个有效立场之间的显性张力
- `principle` — 高层级启发式规则（不可直接操作）
- `feedback` — 对先前决策的回顾性观察

---

## §2 · 边动词

边在原子 DSL 中声明，并编译为每个原子的 `graph.yaml`。`related:` 字段是主要的边声明位置；其他动词出现在类型专属字段中。

| 动词 | 语义 | 示例 |
|---|---|---|
| `related` | 一般关联——可通过图遍历发现 | `@recipes/method-make-pan-sauce related @recipes/fact-maillard-reaction` |
| `compatible` | 可无冲突地组合 | `@security/persona-threat-modeller compatible @security/persona-red-team` |
| `conflicts` | 互斥——组合器不得同时加载两者 | `@security/persona-threat-modeller conflicts @security/persona-optimist` |
| `see-also` | 信息性交叉引用（无语义约束） | `@example/fact-water-boils-at-100c see-also @example/rule-altitude-affects-boiling` |
| `extends` | 继承目标的所有字段，覆盖指定字段 | `@team/rule-strict-null-checks extends @team/rule-no-implicit-any` |
| `derived-from` | 非继承性衍生（通常是引用） | `@team/rule-no-implicit-any derived-from @team/source-typescript-strict-docs` |
| `requires` | 强依赖——若 A 被加载，B 也必须加载 | `@recipes/method-make-pan-sauce requires @recipes/step-deglaze-pan` |
| `enhances` | 软依赖——B 改善 A 但不是必须的 | `@security/persona-threat-modeller enhances @security/taxonomy-owasp-top10` |
| `validates-with` | A 的正确性由 B 验证 | `@security/pattern-parameterised-query validates-with @security/source-owasp-a03-injection` |
| `supplies-to` | A 提供 B 消费的值 | `@recipes/fact-maillard-reaction supplies-to @recipes/method-sear-steak` |
| `specializes` | A 是 B 的更窄子类型 | `@security/rule-sql-injection-prevention specializes @security/rule-injection-prevention` |
| `contradicts` | A 和 B 做出语义上对立的断言（L3 标记） | `@team/rule-no-implicit-any contradicts @community/fact-typescript-infers-safely` |
| `relationships` | 通用兜底（用于旧版源原子） | — |
| `includes` | 集合原子列举其成员原子 | `@example/collection-tea-basics includes [@example/fact-water-boils-at-100c, ...]` |

---

## §3 · 组合约束（协议层）

协议定义两个通用组合约束字段：

```
<kind> SomeName {
  ...
  composition: {
    must-include: [@scope/atom-a, @scope/atom-b]
    must-avoid:   [@scope/atom-c]
  }
}
```

- `must-include` — 选中此原子时，agent 的已加载原子集中**必须**出现的原子。
- `must-avoid` — **不得**出现的原子（冲突约束 / 美学排除）。

**L3 约束检查**（`packages/validator-core/`，v0.2 计划）：在 agent 生成开始前验证 `must-include` 原子已加载、`must-avoid` 原子未加载。v0.1.0 中约束由检索器执行，但尚无独立的 validator runner。

领域包装器可定义额外的类型化子字段（如前端设计领域中的 `typography-required`、`color-required`、`motion-prescriptions`）。这些子字段由领域专用工具解析，存在于语料库原子中——不在系统仓库的 `AtomMeta` 类型里。详见 [`FRONTEND-DESIGN-DOMAIN-v1.zh-CN.md`](./FRONTEND-DESIGN-DOMAIN-v1.zh-CN.md) §3。

---

## §4 · 检索——`aoe_query`

协议暴露**一个 MCP 工具**：`aoe_query`。领域包装器可在此基础上附加额外工具；附带的前端设计包装器提供五个工具（见 [`FRONTEND-DESIGN-DOMAIN-v1.zh-CN.md`](./FRONTEND-DESIGN-DOMAIN-v1.zh-CN.md) §5）。

### `aoe_query`

```
输入：
  scope:  "atoms" | "related" | "show"
  query?: string          — 关键词检索（scope=atoms）
  id?:    string          — 原子 ID（scope=related | show）
  level?: "summary" | "core" | "full"   — 投影层级（默认："core"）
  kind?:  string          — 可选的类型过滤
  limit?: number          — 前 N 条（默认 10）

输出：
  {
    results: Array<{
      id:          string,
      kind:        string,
      description: string,
      tokens:      number,
      level:       "summary" | "core" | "full",
      path:        string,     // agent 读取此文件——服务器不发送内容
    }>,
    total_index_tokens: number,
  }
```

**评分**：关键词匹配 × quality.overall。不同类型无特权。需要类型优先级重排的领域包装器在接收 `aoe_query` 结果后在自己的层中应用。若要在语料库范围内提升特定类型，设置 `PRIME_KIND_BOOSTS='{"rule":0.5,"check":0.4}'`（JSON 映射；默认为空——28 种类型平等对待）。

**轴检索**是领域级概念，不是协议保证。领域在 `domain.yaml` 中声明自己的轴；协议提供底层关键词匹配 + 边图引擎。详见 [`DOMAIN-EXTENSION-SPEC.zh-CN.md`](./DOMAIN-EXTENSION-SPEC.zh-CN.md) §2。

---

## §5 · 投影层级（L1 / L3）

每个编译后的原子最多以三个投影层级输出：

| 层级 | 内容 | 典型 token 数 |
|---|---|---|
| `summary` | id、kind、description、tags | ~50 |
| `core` | 除正文/示例外的所有字段 | ~200 |
| `full` | 包含正文和所有计算字段的完整原子 | ~800 |

**L2 投影**（LLM 辅助语义丰富）是可选的。当编译时设置了 `ANTHROPIC_API_KEY` 或 `DEEPSEEK_API_KEY`，编译器运行 LLM 通道以丰富摘要描述并检测跨原子语义冲突。无 Key 时跳过 L2，语料库仍在 L1+L3 下正常编译。

---

## §6 · HTTP 注册中心合约

包注册中心（`packages/registry/`）通过 HTTP 提供原子服务。

| 路由 | 方法 | 说明 |
|---|---|---|
| `GET /atoms` | GET | 列出所有原子 ID 和元数据 |
| `GET /atoms/:id.prime` | GET | 获取原子 `:id` 的原始 `.prime` 源文件 |
| `GET /health` | GET | 存活检查 |

`aoe install @scope/name --remote <url>` 从此端点拉取缺失原子，写入本地源目录。

---

## §7 · 领域——插件架构

Prime 不内置任何领域。所有领域通过 `createConfigDrivenRegistry(rootDir)` 在语料库启动时发现并加载 `domain.yaml` 文件。

领域插件接口：`packages/runtime/src/domain-plugin.ts`
配置驱动加载器：`packages/runtime/src/domain-config.ts`

完整 `domain.yaml` schema：[`spec/DOMAIN-EXTENSION-SPEC.zh-CN.md`](./DOMAIN-EXTENSION-SPEC.zh-CN.md)。

烹饪语料库的 `domain.yaml` 示例：

```yaml
id: cooking
version: "0.1.0"
label: Culinary techniques and recipes
axes:
  - id: technique
    label: Cooking technique
    matches: [step, method, transform]
  - id: ingredient
    label: Ingredient knowledge
    matches: [fact, term, value]
```

---

## §8 · 验证层

Prime 实现分层验证流水线：

**L1 — 解析器 schema 验证**（`packages/compiler/src/checker-l1.ts`）：
- 验证 `.prime` DSL 语法是否符合语法规范
- 检查各原子类型的必填字段
- 解析 `@scope/id` 引用以确认目标存在
- 检测重复 ID

**L2 — LLM 辅助语义验证**（`packages/compiler/src/checker-l2.ts`）——需手动开启：
- 逐原子一致性检查："此原子内部是否自洽？"
- 跨原子冲突检测
- 未配置 LLM API Key 时跳过

**L3 — 跨原子图一致性**（`packages/compiler/src/checker-l3-cross.ts`）：
- 检测 `requires:` 图中的循环依赖
- 标记指向活跃原子的 `contradicts:` 边
- 验证 `must-include` 目标存在于语料库中

**L5 — 输出验证** — 依赖于领域：
- 协议定义该层的插槽；验证逻辑是领域专用的
- 附带的前端设计领域实现了 HTML 结构 + 美学对齐检查（见 [`FRONTEND-DESIGN-DOMAIN-v1.zh-CN.md`](./FRONTEND-DESIGN-DOMAIN-v1.zh-CN.md) §8）
- 法律文档领域可验证 PDF/Markdown 结构；安全领域可验证策略覆盖度

注意：命名中不存在"L4"。L1–L3 是编译期；L5 是运行时输出验证。

---

## §9 · 生命周期 / 版本管理

原子携带 `version` semver 字段。生命周期状态：

- `active` — 当前有效，完全支持
- `deprecated` — 为兼容性保留；当 `deprecated` 原子出现在检索结果中时，编译器**必须**发出警告
- `experimental` — 可能在不通知的情况下变更；编译器**可能**发出信息性提示

**v1 限制**：编译器当前不在构建时强制执行生命周期检查，计划在 v1.1 实现。

**Semver 注册中心**（`aoe install`）：原子作为源文件分发于 `<corpus>/primes/sources/` 目录树中。跨团队分发：`aoe install @scope/name --remote <url>`。

---

## §10 · 构建 + 运行时

```bash
# 编译语料库
aoe compile --src primes/sources --out primes/compiled

# 启动 MCP 服务器（单工具：aoe_query）
AOE_CORPUS_DIR=/abs/path/to/compiled \
  bunx @aoe/mcp-server-core
```

运行时依赖：Node 22+（原生 TS 剥离）或 Bun。无需 esbuild。

---

*协议版本：1.0 · 更新时间：2026-05-09*
