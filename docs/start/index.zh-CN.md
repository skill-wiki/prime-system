# 构建你的第一个领域 Runtime

AOE 让应用真正拥有一个可以使用的领域。你提供 Model Package（词汇与
规则）和 Corpus Package（知识与证据），AOE 把它们编译成可验证的 Snapshot，
供 Agent 或应用查询、查看并在授权后执行 Action。

你不需要把整本手册塞进 Prompt，也不需要把 Ticket 写进引擎，更不需要为每个
领域重新实现一套检索系统。

## 你应该从哪里开始

| 你想做什么 | 从这里开始 |
|---|---|
| 让 Agent 或应用使用已有 Package | [连接 Agent](../guides/connect-agent.zh-CN.md) |
| 为新领域定义类型、关系、Query 或 Action | [Package 模型](../concepts/package-model.zh-CN.md) |
| 把来源资料编译为版本化知识 Release | [编译与 Snapshot](../concepts/compilation-and-snapshots.zh-CN.md) |
| 控制 Agent 能修改什么 | [Action 与 Policy](../guides/actions-and-policies.zh-CN.md) |
| 发布、回滚或迁移 Release | [Release 与运维](../operations/releases-and-migrations.zh-CN.md) |

## 你会得到什么

每次成功构建都会生成一个可以在机器之间移动的 Release：

```text
Model Package + Corpus Package
              │
              ▼
       compile · check · sign
              │
              ▼
       verified runtime snapshot
          │                 │
       query / plan      action / evidence
```

Snapshot 包含编译后的 Unit artifact、模型定义的 Projection、Index、Manifest
和 Model Lock。Runtime 在提供任何内容之前验证 identity 和内容；文件被替换
时，Release 会失败，而不是静默地“尽量读取”。

## 五分钟路径

### 1. 安装 Engine

```bash
git clone https://github.com/skill-wiki/kernary-engine.git
cd kernary-engine
bun install --frozen-lockfile
```

### 2. 构建示例

仓库带有一个很小的示例，让你先看到完整链路，再创建自己的领域：

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

这里显式传入 Model 路径，是为了说明示例词汇属于示例 Package，而不是 AOE
Core。

### 3. 连接客户端

如果使用 MCP，请挂载构建时使用的同一个 Snapshot 和 Model：

```bash
AOE_CORPUS_DIR=examples/hello-world/primes/compiled \
AOE_MODEL_DIR=compat/prime-v1-model \
bun packages/mcp-server-core/src/index.ts
```

进程内集成使用 SDK，独立服务使用 HTTP Transport。三者暴露同一套 Query 和
Action 契约。

## 创建自己的 Domain Package

建议把领域放在独立仓库，而不是把领域文件塞进 Engine：

```text
my-domain/
├── model/                 # types、fields、relations、projections、actions
├── corpus/                # units、sources、provenance、release metadata
├── adapters/              # 可选 importer 与外部 provider
├── tools/                 # 可选领域工具
└── README.md
```

Model Package 告诉 AOE 有效对象和关系是什么；Corpus Package 提供对象及其
来源；Adapter 可以导入外部目录或绑定 Provider；Domain Package 则是这些部分
的可部署组合。

## 应用如何发起 Query

应用发送领域无关的请求，具体哪些字段、关系、Projection 和 Retrieval profile
有意义，由 Model 决定：

```json
{
  "corpus": "com.example/support",
  "query": "影响 checkout 服务的未关闭事故",
  "topK": 8,
  "projection": "core"
}
```

响应包含 Selection Plan：选中了哪些 Unit、为什么匹配、应用了哪些约束，以及
客户端下一步可以加载哪些字节。你可以记录或测试这个 Plan，而不必从结果列表
反推一套排序算法。

## 受治理的写入

如果应用需要改变状态，应调用声明过的 Action，而不是把一段检索到的文字临时
变成工具调用。Action 契约定义输入、输出、Capability、Precondition、Policy、
Approval、幂等和证据。Query 权限与写入权限始终分开。

## 发布前检查

针对你的 Package 运行：

```bash
bun run typecheck
bun run test
bun run build
```

Corpus Package 还应运行声明一致性和 Bundle 验证。不要手工编辑 `_index.xml`、
`corpus.manifest.json` 或 `model.lock`；从 Source 重建，才能保持 Digest 与
Provenance 可信。

## 下一步

- [理解 Package 模型](../concepts/package-model.zh-CN.md)
- [编译可验证 Snapshot](../concepts/compilation-and-snapshots.zh-CN.md)
- [连接 Agent](../guides/connect-agent.zh-CN.md)
- [运维 Release](../operations/releases-and-migrations.zh-CN.md)
