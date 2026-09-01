# AOE 文档

AOE 是面向 Agent 的本体引擎。这里描述当前 Package、
Snapshot、Query 与 Action contract。

## 开始

- [构建你的第一个领域 Runtime](../start/index.zh-CN.md)
- [连接 Agent](../guides/connect-agent.zh-CN.md)

## 核心概念

- [Package 模型](../concepts/package-model.zh-CN.md)
- [编译与 Snapshot](../concepts/compilation-and-snapshots.zh-CN.md)
- [Selection 与 Execution](../concepts/selection-and-execution.zh-CN.md)

## 构建与运维

- [Action 与 Policy](../guides/actions-and-policies.zh-CN.md)
- [Release 与 Migration](../operations/releases-and-migrations.zh-CN.md)

## Reference

- [CLI 兼容面](reference/cli.md)
- [MCP Transport](../reference/mcp-transport.zh-CN.md)
- [HTTP 与 Registry](../reference/http-and-registry.zh-CN.md)
- [术语表](../style/terminology.md)

Engine 文档由本仓库拥有。Domain Package 自己拥有 Model、Corpus、Adapter、工具
和 Case Study。网站只渲染所属仓库的版本化 Markdown，Owner Source 缺失时应
Fail closed。

历史材料保存在 [`legacy/`](../legacy/)；Lane 报告位于 `internal/`，都不属于当前
产品指南，也不会作为用户文档发布。

[English](../README.md)
