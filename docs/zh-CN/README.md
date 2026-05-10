# Skill Wiki 文档

[English](../README.md) · [中文](./README.md)

类型化原子 · 边图 · 懒加载投影 —— AI 知识的协议层。
这份索引列出文档树里的每一篇。

---

## 入门

- [getting-started](./getting-started.md) —— 从 `git clone` 到 agent 能查询的类型化 corpus，10 分钟跑通。

## 概念

- [architecture](./concept/architecture.md) —— 流水线、分层、各 package：brief 怎么变成 context。
- [philosophy](./concept/philosophy.md) —— 架构**为什么**长这样。
- [comparison](./concept/comparison.md) —— Skill Wiki 与 RAG / Skills / fine-tuning 等方案的对比。

## 指南

- [corpus-authoring](./guides/corpus-authoring.md) —— 端到端写一个自己的类型化 corpus。
- [domain-extension](./guides/domain-extension.md) —— 在协议之上扩展新领域。
- [mcp](./guides/mcp.md) —— 把 MCP server 接到 Claude Code、Cursor 或任何客户端。

## 参考

- [cli](./reference/cli.md) —— 每个 `prime` 子命令和 flag。
- [dsl-quickref](./reference/dsl-quickref.md) —— 28 种原子 kind 和 14 条边动词速查。
- [registry](./reference/registry.md) —— 发布、版本管理、发现 corpus。

## 社区

- [roadmap](./community/roadmap.md) —— v0.2 及之后的规划。
- [governance](./community/governance.md) —— RFC 分级、决策流程、投票规则。
- [maintainers](./community/maintainers.md) —— 当前维护者与自荐路径。
- [faq](./community/faq.md) —— 常见问题，包括 "这是 RAG 吗？"。
- [known-issues](./community/known-issues.md) —— v0.1.0 当前的限制。

---

另见：[协议规范 v1](../../spec/PRIME-PROTOCOL-v1.md) · [前端领域规范](../../spec/FRONTEND-DESIGN-DOMAIN-v1.md) · [仓库 README](../../README.zh-CN.md)。
