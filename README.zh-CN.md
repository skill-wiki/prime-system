# Kernary

Kernary 把领域模型和语料编译成供 Agent 使用的版本化 Runtime。Agent 可以
查询不可变 Snapshot、获得带约束与依据的 Selection Plan，也可以通过 SDK、
MCP 或 HTTP 调用经过 Policy 控制的 Action。

引擎本身不附带生产 ontology。类型、字段、关系、投影、检索 Profile、
Action、Policy 和 Validator 由外部 Model Package 定义；Unit 与资产属于
Corpus Package。Ticket、Recipe、Security 和 Frontend Design 都是构建在
Kernary 上的例子，不是 Core 内置 schema。

```text
Model Package + Corpus Package + Adapters
                    │
                    ▼
        parser → IR → compiler → snapshot
                    │
          query plan      action plan
                    │          │
       constraints      policy + evidence
                    └────┬─────┘
                 SDK · MCP · HTTP
```

## 验证引擎

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

测试会加载 Ticket、Recipe、Security 等互不相同的外部模型。这里要守住的
不是某个领域用例，而是一个不变量：增加领域类型或关系不能要求修改引擎。

## 构建当前维护的示例

v0.2 仍保留 `.prime` v1 兼容语法。当前维护的构建入口是：

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

它会生成不可变 Bundle、`model.lock`、`_index.xml` 和
`corpus.manifest.json`。`compat/prime-v1-model` 拥有历史 Atom schema；它是
兼容 Model Package，不是 Kernary Core。

```bash
PRIME_DIR=examples/hello-world/primes/compiled \
PRIME_MODEL_DIR=compat/prime-v1-model \
bun packages/mcp-server-core/src/index.ts
```

`PRIME_*`、`.prime`、`prime/*`、`prime` CLI alias 和已发布的
`@skill-wiki/*` npm scope 都属于兼容标识。当前产品名统一使用 Kernary；
迁移边界见[命名 ADR](docs/adr/0001-kernary-name-and-product-boundary.md)。

## Package 模型

- **Model Package**：类型、关系、投影、检索、Function、Action、Policy、
  Validator 与 Migration。
- **Corpus Package**：Unit、资产、来源、许可证策略和 Release identity。
- **Adapter Package**：外部来源或 Provider 集成。
- **Domain Package**：Model、Corpus、Adapter、工具和可选 Agent Skill 的组合。

Skill 可以说明 Agent 如何使用某个 Domain Package，但它不拥有 schema、
不授予 capability，也不能替代 SDK 和 Transport。

## Query 与 Action 是两条路径

Query 负责 Candidate、Feature、硬软约束、Relation semantics、Projection
load order 和 token budget。Selection Plan 说明选中了什么以及为什么。

Action 走独立授权路径。外部写入必须经过 Action 声明、Principal 与 Capability
检查、Preflight、Policy、必要的人工审批、Idempotency 和追加式 Event evidence。
能够读取 Unit，不代表能够修改外部状态。

## 文档

- [从这里开始](docs/start/index.zh-CN.md)
- [Package 模型](docs/concepts/package-model.zh-CN.md)
- [编译与 Snapshot](docs/concepts/compilation-and-snapshots.zh-CN.md)
- [Selection 与 Execution](docs/concepts/selection-and-execution.zh-CN.md)
- [术语表](docs/style/terminology.md)

Kernary 使用 Apache-2.0。GitHub remote 与 npm scope 只有在外部改名和双发
完成后才会更新；文档不会提前假装这些步骤已经发生。
