# AOE CLI

`aoe` 是查看 Model Package、构建 Corpus Package、诊断 Snapshot 和本地运行
Action 的最快入口。

```text
AOE v0.2.0 — Agent Ontology Engine

Usage: aoe <command> [options]
```

运行 `aoe --help` 查看当前命令；每个 Subcommand 都有自己的帮助信息和退出码。

## 命令速览

| 目标 | 命令 |
|---|---|
| 初始化和检查 Package | `init`、`compile`、`check`、`graph` |
| 查看 Package 数据 | `list`、`show`、`deps`、`install` |
| 发布与发现 Package | `publish`、`search`、`info`、`ls` |
| 检查 Snapshot | `doctor` |
| 测试 Action 与 Run | `action preflight`、`action run`、`run inspect`、`run replay` |
| 编辑器支持 | `lsp diagnostics`、`lsp completion` |
| 整理既有指导内容 | `decompose`、`compose` |

## 一次本地流程

```bash
aoe check ./my-domain/model
aoe deps ./my-domain/model

aoe compile ./my-domain/corpus/sources/incident.prime \
  --output ./build/incident --dir --bundle

aoe doctor --dir ./build/incident --strict-manifest
```

正式 Domain Package 可以把这些步骤封装在自己的 Build script 中，以加入 Adapter、
签名或评估门禁。

## 诊断和退出码

`doctor` 会报告 Snapshot identity、Active/Deprecated Unit 数量、token 总量和所有
Diagnostic。`--json` 适合 CI：

```bash
aoe doctor --dir ./build/incident --strict-manifest --json
```

Bundle 缺失、Manifest 与 Index/Content 不一致，或 Model Package 无法加载时，命令
返回非零退出码。

## Editor 支持

`lsp` 为 Model 与 Corpus 声明提供 Diagnostics 和 Completion。它只读取你指定的
Package，不会发明领域字段，也不会在编辑器进程内构建 Runtime Bundle。

## Query 与 Action 边界

CLI 可以检查和运行 Package，但通用 Query Engine 与 Action Runtime 仍是 SDK、MCP
和 HTTP 使用的同一套库。应用需要长驻服务、Tenant Context、Policy Provider 或
Event Evidence 时，应使用这些 Integration。

## 发布

`publish` 会修改外部 Package Registry。只有在声明一致性、Bundle 验证、签名和
Release Review 都通过后才应执行。Registry 保存 Package metadata 与不可变 Release
引用，不改变 Model 或 Corpus 语义。
