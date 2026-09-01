# Kernary

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/kernary-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/kernary-logo.svg">
    <img src="docs/assets/kernary-logo.svg" alt="Kernary" width="540">
  </picture>
</p>

<p align="center">
  <img src="docs/assets/kernary-logo.svg" alt="Kernary" width="540">
</p>

<p align="center">
  <strong>让软件能够理解、决策并行动的模型驱动本体基础设施。</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="https://skill-wiki.github.io/zh/docs">中文文档</a> ·
  <a href="https://github.com/skill-wiki/kernary-engine/actions/workflows/ci.yml"><img src="https://github.com/skill-wiki/kernary-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a> ·
  <a href="LICENSE">Apache-2.0</a>
</p>

Kernary 是一个**模型驱动的本体引擎**。它把外部领域 Model 与 Corpus 编译
成确定性、可版本化、可验证的 Runtime。应用或 Agent 可以通过 Embedded SDK、
MCP 或 HTTP 使用同一套契约：先发现有什么，再请求带约束的 Selection Plan，
按需解析 Projection，最后在明确授权的前提下执行 Action。

一句话概括：**Kernary 是引擎；领域词汇与领域数据是围绕引擎组织的外部
Package。** Core 不内置生产 Ticket schema、设计 ontology，也不维护一份
固定的 atom kind 清单。

## 为什么需要它

大多数 Agent 知识系统从文档或 Skill 文件开始。作为编写格式它们很实用，
但到了运行时，系统还必须回答四个更难的问题：

1. 这个领域到底是什么意思？哪些类型和关系有效？
2. 对当前请求应该加载哪些知识，选择依据是什么？
3. Runtime 能否证明读到的 Snapshot 就是刚刚构建并发布的版本？
4. Agent 可以读取什么，又真正有权修改什么？

Kernary 把这些问题变成明确契约，同时不把 Core 绑在某个领域上：Model
声明词汇，Corpus 提供单元与证据，Compiler 产生经过验证的 Snapshot，Query
返回可解释的 Plan，Action 走独立的授权和证据链。

## 边界

```text
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  Model Package   │  │  Corpus Package  │  │ Adapter / Tools  │
│ 类型、关系、策略 │  │ 单元、来源、发布 │  │ Provider、评估器 │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         └─────────────────────┼─────────────────────┘
                               ▼
                    ┌────────────────────┐
                    │   Kernary Engine   │
                    │ parse → IR → build │
                    │ verify → snapshot  │
                    └─────────┬──────────┘
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
       Selection Plan                    Governed Action
             │                                 │
             └──────────────┬──────────────────┘
                            ▼
                    SDK · MCP · HTTP
```

### 每一层负责什么

| 边界 | 负责 | 不负责 |
|---|---|---|
| Kernary Core | meta-schema、IR、parser、compiler、Snapshot 验证、Query/Action 契约 | 领域类型名、业务规则、Corpus 内容 |
| Model Package | 类型、字段、关系、Projection、Retrieval、Function、Action、Policy、Migration | 编译后的 Corpus bytes |
| Corpus Package | Unit、资产、来源、许可证、Release、签名 | 引擎实现 |
| Adapter Package | Source importer、Provider、Validator、Evaluator | 修改 Core Schema |
| Domain Package | Model + Corpus + Adapter + Tools + 可选 Agent Skill 的可部署组合 | 为单一领域改 Core |

判断边界是否正确很简单：把 `Ticket` 换成 `Recipe` 时，如果必须修改引擎的
`switch`，设计就错了；如果只需要更换外部 Model、Corpus 和必要的 Adapter，
说明 Core 正在做它应该做的事。

## Runtime 如何工作

### 1. Model-driven 编译

Compiler 读取 Model Package 与源 Unit，把它们归一化到共享 IR，按 Model
声明生成 Projection，并写出确定性的 Bundle：

```text
model/ + corpus/sources/
          │
          ├─ parser + 结构检查
          ├─ IR normalization
          ├─ projection / relation 编译
          ├─ corpus index + manifest + model lock
          └─ 可选 detached signature
                    │
                    ▼
          immutable verified snapshot
```

`_index.xml`、Projection artifact、`corpus.manifest.json` 与 `model.lock` 都是
生成物，不能手工编辑。Runtime 在提供 Snapshot 前会验证 identity、路径、
签名（如启用）和 canonical content digest。

### 2. 可解释 Query

Query 不返回一串无法追溯的字符串，而是返回 `SelectionPlanIR`，其中包括：

- Candidate generator 与 Feature contribution；
- 在排序前执行的 Visibility 与 Principal filter；
- Hard constraint 与 Soft preference；
- Relation closure、扩展、排除、Cycle policy 与 Load order；
- Projection level 与 token budget 决策；
- 外部 Generator 或 Relation semantic 不可用时的诊断信息。

这个 Plan 既给 Agent 使用，也能用于测试、审计日志和人工排查“为什么选中”。

### 3. 受治理的 Action

读和写是两条不同路径。Action 必须声明输入输出、side effect、capability、
precondition、幂等策略和审批要求。Runtime 可以执行 preflight 与 dry-run，
校验 Principal，求值 Policy，在必要时请求人工审批，在有界范围内重试，并把
证据追加到 Event Store。读取 Unit 永远不会自动获得修改外部状态的权限。

## 快速开始

仓库是 TypeScript workspace，使用 [Bun](https://bun.sh/) 安装、构建和测试；
HTTP/MCP 的消费者可以使用 Node.js 22+。

```bash
git clone https://github.com/skill-wiki/kernary-engine.git
cd kernary-engine
bun install --frozen-lockfile

bun run typecheck
bun run test
bun run build
```

不安装全局命令也可以直接运行 CLI：

```bash
bun packages/cli/src/index.ts --help
bun packages/cli/src/index.ts --version
```

### 构建并挂载最小示例

Engine 仓库保留了用于检查完整链路的兼容示例。它们不是 Core 内置 ontology：

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

输出是包含 index、Projection、manifest 与 lock 的可验证 Snapshot。通过通用
MCP Transport 暴露它：

```bash
PRIME_DIR=examples/hello-world/primes/compiled \
PRIME_MODEL_DIR=compat/prime-v1-model \
bun packages/mcp-server-core/src/index.ts
```

`PRIME_*` 环境变量和 `prime` 命令是兼容别名；新的集成文档统一使用 Kernary。

## 不改引擎，编写自己的领域

一个 Domain Package 通常长这样：

```text
my-domain/
├── model/
│   ├── model.yaml              # types、relations、projections、actions
│   └── policies.yaml           # policy sets
├── corpus/
│   ├── sources/                # source declarations / unit inputs
│   └── corpus.yaml             # identity、provenance、publication policy
├── adapters/                   # 可选 source/provider 集成
├── tools/                      # 可选领域 MCP / HTTP handlers
└── README.md
```

声明格式是 Package contract，而不是 Core 常量。建议按以下顺序阅读：

- [Package 模型](docs/concepts/package-model.zh-CN.md)
- [定义并运行一个领域](docs/start/index.zh-CN.md)
- [连接 Agent](docs/guides/connect-agent.zh-CN.md)
- [Actions 与 Policies](docs/guides/actions-and-policies.zh-CN.md)
- [Releases 与 Migrations](docs/operations/releases-and-migrations.zh-CN.md)

[Frontend Design Domain Package](https://github.com/skill-wiki/kernary-frontend-design)
只是一个参考实现。Workspace 中的 Security、Backend、Mobile 和 Cooking
Corpus 是额外的通用性测试夹具，不是 Core 功能。

## Package 地图

Workspace 按契约组织，而不是按某个框架堆成一个大包：

| 区域 | Packages | 职责 |
|---|---|---|
| 声明 | `model-schema`、`corpus-schema` | 加载并验证外部 Package 数据 |
| Language / IR | `parser`、`types`、`ir` | 解析源语法，承载稳定契约 |
| Build | `compiler`、`bundle` | 编译 Unit、Projection、Index、Manifest、Lock |
| Read path | `runtime`、`query-engine`、`constraint-solver`、`projection-engine` | 验证 Snapshot，生成 Selection |
| Write path | `action-runtime`、`policy-engine`、`event-store` | 治理 Action，记录证据 |
| Integration | `sdk`、`sdk-codegen`、`mcp-server-core`、`http-server`、`cli` | 向宿主暴露同一套契约 |
| Extension / Quality | `plugin-host`、`registry`、`observability`、`evaluation-engine`、`testkit`、`language-server` | Adapter、分发、观测、评估与工具 |

Workspace 包目前仍使用已发布的 `@skill-wiki/*` scope，以便完成兼容和双发迁移。
这是 Package namespace，不是产品名称。

## 安全与可复现性不变量

Kernary 在重要边界上采用 fail-closed：

- canonical digest 与 checkout 位置、对象顺序无关；
- Manifest 或 Projection 被篡改时，在返回内容前失败；
- 路径穿越、绝对路径、symlink 逃逸、FIFO 和其他非普通文件被拒绝；
- Visibility 在排序和 Relation 扩展之前执行；
- Hard constraint 不能被更高分数抵消；
- Capability 与 Policy 在 effectful execution 之前校验；
- 幂等键按 tenant/workspace 隔离，冲突 replay 失败关闭；
- 外部 Provider 不可用时返回诊断，不伪造通过。

运行 `bun run test` 可以检查这些不变量；集成 workspace 使用更强的
`bun run verify` 进行跨包验证。

## 项目状态

v0.2 Engine、SDK、通用 Query Planner、受治理 Action Runtime、MCP/HTTP
Transport、Model/SDK Codegen、Language Server 基础设施和参考 Domain Package
已经实现并通过测试。托管 Registry、第一方评估服务和生产级 Observability
部署是后续扩展产品，不是 Core 的隐藏前提。

下一阶段应继续完善 Package 分发与迁移工具，而不是把某个领域的分支写回引擎。

## 贡献

引擎改动提交到本仓库；领域词汇和 Corpus 内容提交到 Domain Package。提交 PR 前：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

请阅读[贡献指南](.github/CONTRIBUTING.zh-CN.md)或
[English contributing guide](.github/CONTRIBUTING.md)。安全问题请阅读
[SECURITY.zh-CN.md](.github/SECURITY.zh-CN.md)。

## 许可证

Kernary Engine 使用 [Apache-2.0](LICENSE)。外部 Domain 与 Corpus Package
遵循各自的来源署名和许可证条款。
