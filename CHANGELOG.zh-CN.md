# 变更日志

本文记录 Kernary Engine 的重要变更。Domain Package（如 `aoe-frontend-design`）维护各自独立的变更日志。

格式参照 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本规范遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

协议版本与实现版本独立迭代。下方条目中 `[spec: vX]` 标签标注了每个发布版本所实现的协议版本。

---

## [Unreleased]

### 计划中

- 生命周期强制检查：编译器在检索结果中出现 `deprecated` 原子时发出警告。
- `type` 表达式的结构化 AST（函数签名、联合类型、范围）——目前作为不透明字符串处理。
- 正式的领域插件协议——用注册插件接口替换临时的 `domain:` 元数据字段。
- L2 LLM 校验器稳定化（当前标记为实验性；由 `DEEPSEEK_API_KEY` 控制）。

---

## [0.1.0] — 2026-05-09  · `[spec: v1.0]`

首个公开版本。

### 新增

- `packages/parser/` — `.prime` 词法分析器 + 递归下降解析器（62 个测试）。支持 28 种原子类型、14 种边动词、连字符关键字字段、三引号块、原子引用（`@scope/id`）、函数签名类型表达式、联合类型、范围表达式。
- `packages/types/` — AtomKind、EdgeVerb、ProjectionLevel、AtomRef、CompositionContract 的共享 TypeScript 类型定义。
- `packages/compiler/` — L1 结构校验器（必填字段、原子类型 schema、引用解析、重复 ID 检测）和 L3 跨原子图校验器（`requires:` 中的循环依赖检测、`must-include` 语料库存在性校验、`contradicts:` 标记）。L2（按原子 DeepSeek 语义校验）由 `DEEPSEEK_API_KEY` 控制，标记为实验性。
- `packages/runtime/` — 原子加载器、投影解析器（`summary` / `core` / `full`）、领域插件宿主存根。
- `packages/registry/` — HTTP 包注册中心，支持发布（PUT）和安装（GET）端点，基于 Token 的鉴权。
- `packages/cli/` — `prime` 命令，支持动词：`init`、`compile`、`check`、`ls`、`show`、`graph`、`deps`、`publish`、`install`、`mcp`。
- `packages/mcp-server-core/` — 约 200 行的通用 MCP 服务器，通过任意编译语料库暴露单一工具 `aoe_query`。
- `spec/PRIME-PROTOCOL-v1.md` — 协议规范，v1.0。
- `spec/FRONTEND-DESIGN-DOMAIN-v1.md` — 前端设计领域包装规范。
- `examples/hello-world/` — 5 个原子的语料库，演示在简单领域（烧水、泡茶）的完整流程。
- `examples/recipes/` — 15 个原子的语料库，跨越烹饪技巧、食材、步骤和规则。
- `examples/coding-style/` — 12 个原子的语料库，对团队 lint 规则和反模式进行建模。
- 文档：`docs/getting-started.md`、`docs/architecture.md`、`docs/philosophy.md`、`docs/dsl-quickref.md`、`docs/cli.md`、`docs/mcp.md`、`docs/registry.md`、`docs/corpus-authoring.md`、`docs/comparison.md`、`docs/faq.md`——均提供英文和中文版本。
- CI 工作流运行解析器、编译器、运行时测试；对每个示例进行冒烟编译；执行注册中心端到端测试。

### 设计决策

- **双仓库拆分。** Engine（本仓库）仅承载协议实现。Frontend Design Domain Package（`aoe-frontend-design`）承载历史 899-unit corpus，以及领域专用的 intent / retrieval / composition / validator-html / MCP 工具。
- **许可证：Apache-2.0。** 专利授权明确。NOTICE 在所有仓库中保留。
- **无模型锁定。** L2 / intent / 美学验证可使用任何支持 chat-completions 兼容 API 的 LLM。
- **仅支持 Node 22+。** 通过 `--experimental-transform-types` 实现原生 TS 剥离，无需打包器即可运行；支持 Bun 作为更快的安装/测试运行器。

### 已知缺口

- L2 语义校验器没有第一方回归测试套件。
- 注册中心暂无端到端 semver 冲突解决。
- 跨 LLM 测试不在本仓库范围内。内部基准测试（约 26% 成本降低 / 1.76× 速度提升，每个条件 N=1）仅供参考。详见语料库仓库的 `docs/benchmarks.md`。

---

[Unreleased]: https://github.com/kernary-aoe/aoe-engine/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kernary-aoe/aoe-engine/releases/tag/v0.1.0
