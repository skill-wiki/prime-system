---
name: prime-decompose
description: 将 Markdown 协议文档（SKILL.md、设计系统规范、团队规则手册等）转换为 Prime 知识语料库的类型化 `.prime` 源原子。当用户要求"分解"、"原子化"、"转换为 prime"或"从任意 Markdown 文档中提取原子"时触发。
---

# prime-decompose

输入一个 Markdown 文档，输出一组候选 `.prime` 原子。
本工具是编写辅助工具；人类在合并前负责审查和编辑。

## 输入

- 一个源路径（`.md` 文件、`.md` 文件目录，或直接粘贴的 Markdown 文本）。
- 一个目标命名空间（如 `@my`、`@team-foo`），默认为 `@my`。
- 一个输出目录，默认为 `./out-prime/`。

若任何输入缺失，询问一次后以默认值继续执行。

## 工作流

### 1 · 读取源文件

使用 Read 工具。若是目录，列出文件后优先处理知识密度最高的文件（最大的非索引 `.md` 文件是个好代理）。

### 2 · 识别原子候选项

逐节遍历文档，为每个有价值的断言标注 **28 种原子类型**之一（见 `reference/atom-kinds.zh-CN.md`）。宁可过度提取再合并，也不要遗漏。

阅读时的默认映射：

| 你看到的内容 | 可能的原子类型 |
|---|---|
| "始终 X" / "绝不 Y" / "MUST" / "MUST NOT" | `rule` |
| 数字/维度值、具名常量 | `value` |
| 有引用的实证性断言 | `fact` |
| "避免……"并附有原因 | `anti-pattern` |
| "使用……"可复用的结构模板 | `pattern` 或 `template` |
| 术语定义 | `term` |
| 对产物的通过/失败断言 | `check` |
| 可测量的阈值 | `metric` |
| 有输入/输出的多步骤过程 | `method` |
| 连贯的设计流派 / 美学风格 | `persona` |
| 写作语调约定 | `voice` |
| 高层级启发式规则（不可直接操作） | `principle` |
| 两个有效立场之间的显性张力 | `tradeoff` |
| 可引用的规范或论文 | `source` |

经验法则：
- 若一个断言**可直接操作且是二元通过/失败**，它是 `rule`，而非 `principle`。
- 有了 `rule`，就需要验证它的 `check`——两者都要输出。
- 有了 `value`（如"44px 触摸目标"），就需要消费它的 `rule`。
- Persona/voice 最后编写——它们通过 `composition:` 捆绑其他原子。

### 3 · 输出 `.prime` 文件

对每个候选项，写入 `<target>/<kind>-<kebab-name>.prime`。使用 `reference/dsl-syntax.zh-CN.md` 中的 DSL 语法。每个原子的必填字段：

```
<kind> <PascalName> {
  id: "@<scope>/<kebab-name>"
  version: "1.0.0"
  description: "..."

  // 类型专属字段——见 reference/atom-kinds.zh-CN.md

  related: [..., ..., ...]   // ≥ 3 个条目
  // ≥ 1 个：extends / derived-from / requires / enhances / specializes
}
```

### 4 · 通过边进行交叉链接

所有原子初稿完成后，进行**第二遍边处理**。对每个新原子：

- 添加**至少 3 个 `related:`** 边，指向可发现的同级原子（你刚写的其他原子，或已知语料库中的现有原子）。
- 添加**至少 1 个**：`extends`、`derived-from`、`requires`、`enhances`、`specializes`。使用 `reference/verb-cheatsheet.zh-CN.md` 中的"何时使用"指南。

若源文档引用了 WCAG、OWASP、Nielsen 等，添加 `derived-from: @w3c/...` 或 `derived-from: @nielsen/...` 边。不要发明不确定是否存在的原子 ID；不确定时省略并标注。

### 5 · 验证

运行验证脚本：

```
bun run release/skills/prime-decompose/scripts/validate-output.ts <target-dir>
```

脚本将打印解析错误和边计数。在汇报之前修复所有错误。

### 6 · 汇报

打印：
- 按类型统计数量（如"12 条 rule，8 个 fact，3 个 anti-pattern……"）
- 每个输出文件的完整路径
- 你**无法原子化**的源断言，并说明原因
- 你引用但无法验证是否存在的外部原子 ID

## 具体示例

**输入**（一行源 Markdown）：
> "使用 4px 基础间距网格；仅使用 4 的倍数。"

**输出**（3 个原子）：

`value-spacing-base.prime`：
```
value SpacingBase {
  id: "@my/value-spacing-base"
  version: "1.0.0"
  name: "spacing-base"
  constant: "4px"
  type: css-length
  domain: frontend-design
  rationale: "4px 基础单位生成 8 点尺度（4, 8, 12, 16, 24, 32, 48, 64, 96, 128），与 iOS/macOS 惯例对齐，且颗粒度足够细以适配密集 UI。"
  related: [
    @my/rule-spacing-rhythm,
    @my/principle-eight-point-grid,
    @community/rule-spacing-rhythm,
  ]
  supplies-to: [
    @my/rule-spacing-rhythm,
  ]
}
```

`rule-spacing-rhythm.prime`：
```
rule SpacingRhythm {
  id: "@my/rule-spacing-rhythm"
  version: "1.0.0"
  domain: frontend-design
  description: "所有间距值（margin、padding、gap）必须是文档尺度中 4px 的倍数。"
  claim: "每个间距 CSS 值解析为 N×4px，其中 N ∈ {1,2,3,4,6,8,12,16,24,32}。"
  severity: medium
  validates-with: [
    @my/principle-eight-point-grid,
  ]
  related: [
    @my/value-spacing-base,
    @my/principle-eight-point-grid,
    @community/anti-pattern-cramped-ui,
  ]
  derived-from: @community/rule-spacing-rhythm
}
```

`principle-eight-point-grid.prime`：
```
principle EightPointGrid {
  id: "@my/principle-eight-point-grid"
  version: "1.0.0"
  domain: frontend-design
  statement: "单一基础单位（4px）及其倍数创造视觉节奏，无需逐组件做间距决策。"
  rationale: "将间距空间约束为离散尺度，消除了一类决策并使漂移可见。iOS/macOS 采用 8pt 以来的行业基线；Tailwind、Material 和 Apple HIG 都共享这一前提。"
  related: [
    @my/value-spacing-base,
    @my/rule-spacing-rhythm,
    @community/principle-vertical-rhythm,
  ]
}
```

注意：
- 三个原子，三种不同类型（value · rule · principle）。
- 每个都有 ≥ 3 个 `related:` 边。
- 两个有非 `related` 动词（`supplies-to`、`derived-from`）。
- `value` 通过 `supplies-to` 被 `rule` 消费，并反向关联。
- `principle` 是高层级启发式规则——不可直接操作。

## 硬性规则

- 绝不擅自改写原子类型——使用 `reference/atom-kinds.zh-CN.md` 中列出的 28 种。
- 绝不在边中发明原子 ID。引用外部原子时，必须确认其存在。
- 绝不输出少于 3 个 `related:` 边的原子。
- 绝不输出缺少 {`extends`、`derived-from`、`requires`、`enhances`、`specializes`} 之一的原子。
- 绝不运行 Prime MCP 服务器。本技能是自包含的 Markdown + Read/Write/Bash。
