<p align="center">
  <img src="./docs/assets/logo.svg" alt="Skill Wiki" width="420" />
</p>

# Skill Wiki

> 类型化原子 · 边图 · 懒加载投影 — AI 知识的协议层。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Spec](https://img.shields.io/badge/spec-v1.0-green.svg)](./spec/PRIME-PROTOCOL-v1.md)
[![Node](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](#%E5%AE%89%E8%A3%85)
[![CI](https://img.shields.io/badge/ci-parser%20%C2%B7%20compiler%20%C2%B7%20runtime-blue.svg)](./.github/workflows/ci.yml)

[English](./README.md) · [中文](./README.zh-CN.md) · [规范](./spec/PRIME-PROTOCOL-v1.md) · [架构](./docs/zh-CN/concept/architecture.md) · [哲学](./docs/zh-CN/concept/philosophy.md) · [文档](./docs)

---

Skill Wiki 把领域知识——设计规则、安全检查、写作风格、分类法——表达成**有类型的原子 + 显式边图，按需加载**。Agent 永远只看一份 ~3 KB 的索引；具体原子只在 brief 真正需要时才载入。

> **存在 ≠ 内容**。这句话扛起整个架构。

<p align="center">
  <img src="./docs/assets/architecture-system.png" alt="Skill Wiki 整体架构 —— 从入口到模型 8 层" width="780" />
</p>

---

## 安装

需要 **Node 22+**。

```bash
git clone https://github.com/skill-wiki/prime-system.git
cd prime-system
bun install
bun run build
```

```bash
bun run packages/cli/src/index.ts --version
# prime 0.1.0
```

---

## 快速上手

```bash
cd examples/hello-world
bun ../../scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled
prime list
PRIME_DIR=primes/compiled bun ../../packages/mcp-server-core/src/index.ts
```

接入 Claude Code（见 [docs/zh-CN/mcp.md](./docs/zh-CN/guides/mcp.md)）：

```json
{
  "mcpServers": {
    "skill-wiki": {
      "command": "bunx",
      "args": ["@prime-lang/mcp-server-core"],
      "env": { "PRIME_DIR": "/abs/path/to/compiled" }
    }
  }
}
```

---

## 一个原子长这样

```prime
fact WaterBoilsAt100C {
  id: "@example/fact-water-boils-at-100c"
  version: "1.0.0"

  statement: "在 1 标准大气压下，纯水的沸点为 100°C（212°F）。"
  confidence: 0.99
  domain: physics

  related: [
    @example/term-celsius,
    @example/rule-altitude-affects-boiling,
  ]

  validates-with: [
    @example/source-nist-water-properties,
  ]
}
```

kind 分两类：一组**核心 kind** 任何 corpus 都会用上；另一组面向特定领域，
适合就用，不适合就略过。

| 层 | Kind |
|---|---|
| **Data** | `fact` `term` `value` `category` `example` `counter-example` `source` `metric` |
| **Behavior** | `step` `check` `transform` `tool` `method` |
| **Composition** | `rule` `taxonomy` `pattern` `anti-pattern` `type` `constraint` |
| **Meta** | `collection` `scope` `tradeoff` `principle` `feedback` |
| **Voice & Style** *（设计 / 内容 / 品牌类 corpus）* | `persona` `voice` `template` `provocation` |

最后一行是给设计 / 文案 / 品牌类 corpus 用的 —— 例如 `persona-stripe-fintech`、
`voice-magazine-editorial`、`template-card-hover-lift`。安全 / 合规类 corpus
基本只用前 4 层，最后一层可以完全跳过。

14 种类型化边动词：`requires` `enhances` `validates-with` `contradicts`
`specializes` `conflicts` `extends` `derived-from` `compatible` `supplies-to`
`see-also` `includes` `related` `relationships`。

### 想给自己的领域加一种 kind 或 verb

28 种 kind + 14 种 verb 在 parser 里是固定的。要加新 kind 或 verb 需要改
parser，并走 Tier-2 RFC 流程（见 [docs/zh-CN/community/governance.md](./docs/zh-CN/community/governance.md)）。
具体路径写在 [docs/zh-CN/dsl-quickref.md](./docs/zh-CN/reference/dsl-quickref.md#extending)：
改 `packages/types/src/ast.ts`、在 `packages/parser/src/lexer.ts` 加 token、
加 chunker 分支、写测试 fixture、提 PR。新 verb 走一样流程。

跳过 parser patch 的 YAML 形式 `custom-kind` 在
[roadmap](./docs/zh-CN/community/roadmap.md) 上。

---

## 文档导航

| | EN | 中文 |
|---|---|---|
| 入门 | [getting-started](./docs/getting-started.md) | [入门](./docs/zh-CN/getting-started.md) |
| 架构 | [architecture](./docs/concept/architecture.md) | [架构](./docs/zh-CN/concept/architecture.md) |
| 哲学 | [philosophy](./docs/concept/philosophy.md) | [设计哲学](./docs/zh-CN/concept/philosophy.md) |
| DSL 速查 | [dsl-quickref](./docs/reference/dsl-quickref.md) | [DSL 速查](./docs/zh-CN/reference/dsl-quickref.md) |
| CLI | [cli](./docs/reference/cli.md) | [CLI](./docs/zh-CN/reference/cli.md) |
| MCP | [mcp](./docs/guides/mcp.md) | [MCP](./docs/zh-CN/guides/mcp.md) |
| Registry | [registry](./docs/reference/registry.md) | [Registry](./docs/zh-CN/reference/registry.md) |
| 写 corpus | [corpus-authoring](./docs/guides/corpus-authoring.md) | [写 corpus](./docs/zh-CN/guides/corpus-authoring.md) |
| 对比 | [comparison](./docs/concept/comparison.md) | [对比](./docs/zh-CN/concept/comparison.md) |
| FAQ | [faq](./docs/community/faq.md) | [FAQ](./docs/zh-CN/community/faq.md) |
| 已知问题 | [known-issues](./docs/community/known-issues.md) | [已知问题](./docs/zh-CN/community/known-issues.md) |
| 协议规范 | [PRIME-PROTOCOL-v1.md](./spec/PRIME-PROTOCOL-v1.md) | — |

---

## 当前状态

- **协议**：v1.0 已冻结（2026-05-07）。
- **实现**：v1 spec ~75%。已完成：parser、compiler L1+L3、runtime、registry、CLI、通用 MCP server。
- **可选**：L2 语义校验器（DeepSeek，~$0.0001/原子），需设置 `DEEPSEEK_API_KEY`。
- **诚实的缺口**：lifecycle / `deprecated` 警告强制、type 表达式结构化 AST、正式 domain plugin 协议。见 [ROADMAP.zh-CN.md](./docs/zh-CN/community/roadmap.md)。

---

## License

[Apache License 2.0](./LICENSE)。包含专利授权；分发时必须保留 [NOTICE](./NOTICE)。
