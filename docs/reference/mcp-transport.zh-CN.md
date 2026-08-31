# MCP Transport

`@skill-wiki/mcp-server-core` 是 Kernary 通用 MCP Transport 当前已发布的兼容
Package。它挂载一个编译 Snapshot 和生成该 Snapshot 的精确 Model Package。

```bash
PRIME_DIR=/absolute/path/to/corpus/dist \
PRIME_MODEL_DIR=/absolute/path/to/model \
bun packages/mcp-server-core/src/index.ts
```

环境变量与 `prime_*` Tool 前缀在 v0.2 期间保持兼容。

## 工具

- `prime_query` 执行模型声明的 Retrieval Profile，返回选中的 Projection 和产生
  该结果的 Decision。
- `prime_plan` 返回相同 Selection arithmetic，但不渲染 Projection。
- `prime_resource` 通过 Runtime 精确读取一个 Projection，不让 Agent 自己解释
  文件路径。

三种工具都有显式 Input schema。缺少 Retrieval signal、Profile SPI 不可用、
Visibility 违规、Projection 缺失或 Model/Bundle identity 不匹配时会返回 Refusal
或 Diagnostic，不能转换成零结果成功。

Domain Package 可以暴露额外的模型投影工具；它们组合通用 Runtime，不会替代它
或把领域 schema 加进 Core。
