# MCP Transport

Kernary 的 MCP Transport 把编译后的 Model + Corpus Snapshot 提供给任意 MCP
Client。它只负责传输：领域词汇由 Model Package 定义，Query/Action 语义由 Runtime
负责。

```bash
PRIME_DIR=/absolute/path/to/corpus/dist \
PRIME_MODEL_DIR=/absolute/path/to/model \
bun packages/mcp-server-core/src/index.ts
```

## 核心工具

- `prime_query` 执行 Model 声明的 Retrieval Profile，返回 Projection 和产生结果
  的决策；
- `prime_plan` 返回同一套 Selection arithmetic，但不渲染 Projection；
- `prime_resource` 通过 Runtime 解析一个精确 Projection URI。

所有工具都有显式 Input schema。缺少 Retrieval signal、Profile Provider 不可用、
Projection 未知、Visibility 被拒绝，或 Model 与 Bundle identity 不一致时都会明确
失败。返回空列表会掩盖部署错误，因此不会作为兜底。

## 挂载多个 Corpus

Embedded Host 可以为每个 Snapshot 创建一个 Server，也可以通过 SDK/HTTP Host 组合
多个 Snapshot。Tenant、Workspace、Corpus、Release 和 Model identity 都应在 Host
配置中明确声明，不要从目录名猜测。

## 领域工具

Domain Package 可以为自己的 Provider 增加模型投影工具。这些工具仍然经过同一个
Runtime 与 Policy 边界，不会替代通用 Query/Resource 工具，也不会把领域 Schema
搬进 Core。
