# Prime 前端设计领域 — v1.0

> 附带的前端设计语料库的领域合约：6 轴检索、组合子 schema（排版 / 颜色 / 动效）、IntentObject、HTML 输出验证以及 5 工具 MCP 接口。

**状态**：草稿——反映 `prime-corpus-frontend` 参考实现（899 个原子）的状态。

> **前置阅读。** 本文档描述的是叠加在通用 Prime 协议之上的前端设计*领域包装器*。请先阅读 [`spec/PRIME-PROTOCOL-v1.zh-CN.md`](./PRIME-PROTOCOL-v1.zh-CN.md) 了解协议基础（28 种原子类型、14 种边动词、`prime_query`、组合约束、领域插件架构）。本文的所有内容均建立在该基础之上。
>
> 如果你在构建非前端领域（安全、法律、食谱、ML……），本文仅供参考。你的领域在 `domain.yaml` 中定义自己的轴，在语料库中定义自己的 `composition:` 子字段。见 [`spec/DOMAIN-EXTENSION-SPEC.zh-CN.md`](./DOMAIN-EXTENSION-SPEC.zh-CN.md)。

---

## §1 · 前端设计领域概览

前端设计语料库提供 899 个原子，覆盖视觉设计、排版、颜色、布局、动效和无障碍。以 `prime-corpus-frontend` 单独分发，不与系统仓库捆绑。

该领域重度使用的原子类型：
- `persona` — 连贯的设计流派（如"stripe-clean"、"magazine-editorial"、"vercel-minimal"），含字体 / 颜色 / 密度 / 动效合约
- `pattern` — 结构性 UI 模式（toast-stack、metric-card、pricing-toggle……）
- `template` — 可复用的代码/标记模板（缓动配置、OKLCH 调色板、shadcn 组件）
- `rule`、`check`、`constraint` — 质量和无障碍约束（WCAG、对比度比例……）
- `fact`、`value` — 设计常量（颜色 token、间距尺度、米勒定律……）
- `voice` — 写作风格（简洁技术型、友好亲切型……）

在本领域中，`persona` 定义为：*一种连贯的设计流派，具备字体、颜色、密度和动效合约——一种具名的美学立场，其他原子引用它以对齐风格。*（注意：协议层对 `persona` 的定义更为通用，见 PRIME-PROTOCOL-v1 §1.2。）

---

## §2 · 前端领域 `domain.yaml`

`prime-corpus-frontend` 语料库附带的 `domain.yaml` 注册了六个检索轴：

```yaml
id: frontend-design
version: "0.1.0"
label: Frontend design — typography, color, layout, motion, a11y
axes:
  - id: register
    label: Design school / persona
    matches: [persona, voice]
  - id: pattern
    label: Structural UI patterns
    matches: [pattern, template, anti-pattern]
  - id: motion
    label: Animation and transition guidance
    matches: [template, pattern]
    tags: [motion, easing, spring, stagger]
  - id: typography
    label: Font, scale, and text layout
    matches: [fact, rule, constraint]
    tags: [typography, font, scale]
  - id: color
    label: Palette, OKLCH tokens, contrast rules
    matches: [template, rule, value]
    tags: [color, oklch, contrast, palette]
  - id: rules
    label: Quality constraints and a11y checks
    matches: [rule, check, metric]
    tags: [a11y, wcag, quality]
```

---

## §3 · 组合约束——前端扩展

前端领域用三个类型化子字段扩展了协议的通用 `composition:` 块：

```
persona Stripe {
  id: "@impeccable/persona-stripe"
  version: "1.2.0"
  description: "Clean, confident B2B SaaS aesthetic."

  composition: {
    typography-required: {
      display: "Söhne | SF Pro Display"
      weight: 300
    }
    color-required: {
      heading: "#061b31"
      shadow: "rgba(83,58,253,0.18)"
    }
    motion-prescriptions: "subtle, purposeful; max 200ms for transitions"
    must-include: [
      @community/template-shadcn-pricing-toggle,
      @community/pattern-metric-card,
    ]
    must-avoid: [
      @impeccable/template-fade-stagger-aggressive,
    ]
  }
}
```

**前端专属子字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `typography-required` | 块 | 字体族和字重约束。由 L3 验证器对 agent 生成的输出强制执行。 |
| `color-required` | 块 | 具名颜色 token 约束（hex、OKLCH、rgba）。 |
| `motion-prescriptions` | 字符串 | 动效意图的文字描述。v1 不进行机器强制执行；作为 agent 指引。 |

**在 `AtomMeta` 中的存储**：系统仓库的 `AtomMeta` 类型不直接承载这些字段，它们存储于 `compositionExtras: Record<string, string>`（通用 bag）。前端工具通过 `compositionExtras["motion-prescriptions"]` 等方式读取。这使协议的 `AtomMeta` 对非前端领域保持干净。

---

## §4 · 多轴检索

前端设计 MCP 包装器在 Layer 1 意图分类后执行 6 轴检索。

| 轴 | 选取内容 | 目标原子类型 |
|---|---|---|
| `register` | 主要设计流派 / persona | `persona`、`voice` |
| `pattern` | 适用于此任务类型的结构性 UI 模式 | `pattern`、`template`、`anti-pattern` |
| `motion` | 动画和过渡指引 | `template`（缓动/弹簧配置）、`pattern`（交错/显现） |
| `typography` | 字体、尺度和文本布局规则 | `fact`、`rule`、`constraint` |
| `color` | 调色板、OKLCH token、对比度规则 | `template`、`rule`、`value` |
| `rules` | 质量约束和无障碍检查 | `rule`、`check`、`metric` |

**各任务类型的预算约束**（来自 `primes/taxonomy/`）：

| 任务类型 | 最大 register 原子数 | 最大 rule/check 原子数 | 总上限 |
|---|---|---|---|
| marketing-landing | 2 | 3 | 12 |
| blog-article | 1 | 2 | 8 |
| product-ui | 2 | 4 | 16 |
| interaction | 2 | 3 | 12 |
| dev-tool | 2 | 4 | 14 |

---

## §5 · MCP 工具

### §5.1 · 生产工具面

两个 `.mcp.json` server，共 6 个工具。父仓的 legacy 入口 `mcp-server/` 与它那份拷贝
`release/prime-corpus-frontend-design/app/mcp-server-frontend/` 已在**第 13 轮（车道
L13-E）删除**。它们在 `.mcp.json` 切向 `mcp-server-core` 时就已不是生产入口——对已接线
路径 `grep PRIME_BACKEND|IS_V3` 返回 0——删除前，它们那五个无对应物的 `prime_query`
scope（`template` `mandate` `checklist` `gallery` `scout`）已记录在
`docs/analysis/legacy-scope-spec.md`。

| Server | 入口 | 工具 |
|---|---|---|
| `prime-wiki` | `release/prime-system/packages/mcp-server-core/src/index.ts` | `prime_query`（`scope=atoms\|related\|show`）、`prime_plan`、`prime_resource` |
| `prime-design` | `domains/prime-frontend-design/mcp/src/server.ts` | `prime_design_plan`、`prime_design_resolve`、`prime_design_validate` |

三个 `prime_design_*` 工具不是手写的：它们由 `sdk-codegen` 的 `emitMcpTools` 从
`domains/prime-frontend-design/model/tools/` 投影而来，因此名称、入参 schema 与
annotation 都来自模型包（§11.2）。用两个 server 而非一个，是因为 §15.4 是单向的——
内核不能 import 领域，聚合进程只能由领域包拥有。

`prime_design_*` 的入参键刻意与它们替代的已退役工具保持一致（`design-actions.yaml`），
且在 `scripts/shadow-mcp/run.ts` 跑过的那些 brief 上，`prime_design_plan` 与已退役的
`prime_intent` 逐字节相同。

### §5.2 · 已退役的 v1 工具面（历史记录）

以下全部描述的是切换前 `mcp-server/index.ts` 的 5 个工具（早期草案称"6 个"——延期工具
已规划但从未发布）。保留它只为溯源，**不是**任何在运行的 server 的描述。其中两处描述对
那个 server 本身也是错的：`prime_validate` 的入参是 `(html_path, brief)` 而非
`(html_path, register, contract)`；`prime_resolve` 接收 `brief` 并返回带类型的设计规格，
而"把原子 id 解析到某个投影层级的内容"是当前 `prime_query scope=show` 与
`prime_resource` 做的事。

### `prime_compile`
主要入口。Brief → 6 轴原子检索计划。

```
输入：
  brief: string          — 自由格式 brief（"邮件订阅, 简单就行"）
  mode: "browse"|"push"  — browse 返回索引供 agent 自选；
                           push 直接注入完整原子内容
  skip_intent: bool      — 绕过 Layer 1，使用原始关键词检索（历史兼容）
  persona_school: enum   — 覆盖 register（历史兼容）
  budget: number         — token 预算上限（历史兼容）
  max_atoms: number      — 最大索引条目数（历史兼容）

输出（browse 模式）：
  {
    intent: IntentObject,
    axes: {
      register: { primary: AtomRef, alternates: AtomRef[] },
      pattern:  AtomRef[],
      motion:   AtomRef[],
      typography: AtomRef[],
      color:    AtomRef[],
      rules:    AtomRef[],
    },
    contract: { must_include: string[], must_avoid: string[] },
    path_template: string,
    turn_budget_hint: number,
  }
```

### `prime_query`
图和语料库遍历（包装协议层的 `prime_query`，来自 `mcp-server-core`）。

```
输入：
  scope: "atoms" | "related" | "template" | "mandate" | "checklist" |
         "gallery" | "scout"
  id: string              — 相关/模板/mandate/checklist 时的原子 ID
  query: string           — atoms/scout/gallery 时的搜索字符串
  limit: number

输出：因 scope 而异
```

### `prime_intent`
仅执行 Layer 1 意图分类（不进行检索）。

```
输入：  brief: string
输出：IntentObject
```

### `prime_validate`
Layer 5 输出验证。

```
输入：
  html_path: string       — 生成的 HTML 文件路径
  register: string        — 期望的 register（"warm-institutional" 等）
  contract: object        — must_include / must_avoid 原子列表

输出：
  {
    l1: { pass: bool, issues: string[] },   // HTML 结构 + 语义标签
    l2: { pass: bool, score: number },      // LLM 美学对齐度
    l3: { pass: bool, missing: string[] },  // 组合约束是否遵守
    feedback: string,                        // 失败时的重试提示
  }
```

### `prime_resolve`
将原子 ID 解析为指定投影层级的完整原子内容。

```
输入：
  id: string
  level: "summary" | "core" | "full"
输出：{ content: string, tokens: number }
```

---

## §6 · IntentObject（Layer 1 分类）

`prime_compile` 调用 DeepSeek（或在 `DEEPSEEK_API_KEY` 缺失时回退至关键词启发式）生成 `IntentObject`：

```typescript
interface IntentObject {
  task_type: string;           // "marketing-landing" | "product-ui" | ...
  sub_type: string;            // "waitlist" | "pricing-b2b" | ...
  register_candidates: Array<{ school: string; weight: number; rationale: string }>;
  vibe: string[];              // ["approachable", "friendly"]
  motion_priority: "low" | "med" | "high";
  density: "tight" | "comfy" | "loose";
  domain: string;              // "consumer-saas" | "fintech" | "security" | ...
  required_axes: string[];
  ambiguity_flags: string[];
}
```

回退机制：未设置 `DEEPSEEK_API_KEY` 时，Layer 1 回退至关键词启发式匹配。

---

## §7 · 前端领域标签

前端设计语料库（899 个原子）中各领域标签的原子数：

| 领域标签 | 原子数 | 说明 |
|---|---|---|
| `frontend-design` | 410（核心）+ 约 299（相邻） | 视觉设计、排版、颜色、布局、动效 |
| `visual-design` | 85 | 品牌、编辑、美学原子 |
| `accessibility` | 62 | WCAG、无障碍检查、焦点模式 |
| `security` | 32 | OWASP、认证流程、输入验证 |
| `ux-design` | 23 | 交互设计、心智模型 |
| `motion` | 13 | 缓动、弹簧配置、交错模式 |
| 其他 | 约 14 | 排版、表单、设计系统等 |

---

## §8 · 输出验证——L5（前端 HTML）

前端领域的 L5 验证器检查生成的 HTML 输出：

- **`l1-structure.ts`**：解析 HTML AST，检查语义标签（`<main>`、`<nav>`、`<h1>`、ARIA 标签）
- **`l2-semantic.ts`**：LLM 调用——"这个 HTML 在 0.8+ 的置信度下是否符合 `{register}` 美学？"
- **`l3-composition.ts`**：验证组合约束中所有 `must-include` 原子都在输出中有所体现
- **`feedback-builder.ts`**：失败时构建结构化重试提示 → agent 重新生成

**验证循环**：agent 生成 → 调用 `prime_validate` → 若任何层失败，接收结构化反馈 → 重新生成。最多 2 次重试。

对于非前端领域，L5 验证由领域自定义：法律文档领域验证 PDF/Markdown 结构；安全领域验证策略覆盖度。协议保留 L5 插槽——实现由领域包装器负责。

---

*领域规范版本：1.0 · 更新时间：2026-05-09 · 语料库：899 个原子*
