# CLI 兼容面

v0.2 的首选命令是 `kernary`。当前已发布的兼容 Package 也会安装 `prime`，两个
Binary 执行同一入口。

```text
Kernary v0.2.0 — model-driven ontology engine for agents and applications

Usage: kernary <command> [options]
```

## 当前命令

| 分组 | 命令 |
|---|---|
| Author 与 Check | `init`、`compile`、`check`、`test`、`graph` |
| 旧 Skill composition | `decompose`、`compose` |
| 本地 Package 数据 | `list`、`show`、`deps`、`install` |
| 兼容 Registry | `publish`、`publish-marketplace`、`search`、`info`、`ls` |
| Bundle 诊断 | `doctor` |
| Action 与 Run | `action preflight`、`action run`、`run inspect`、`run replay` |
| Editor toolchain | `lsp diagnostics`、`lsp completion` |

权威 Syntax 以 `kernary --help` 和对应 Subcommand help 为准。v0.2 迁移期间，
部分 Subcommand message 仍会显示 `prime` alias；脚本应暂时接受两个 Binary。

## 重要限制

- `compile <file>` 是兼容的单 Source 命令。正式 Corpus Release 应使用所属
  Package 的 Build script，确保 Model、Corpus identity、Release date、签名与
  Strict verification 绑定在一起。
- CLI 不替代 Query Engine。通用 Runtime Query 通过 SDK、MCP 与 HTTP 暴露。
- `lsp` 只提供 Editor Diagnostics 与 Completion，不在编辑器进程构建 Runtime
  Bundle。
- Publish 会修改外部 Registry，只有在 Conformance、签名和明确 Release 授权后
  才执行。

`.prime`、`PRIME_*`、`prime/*`、`prime.dev`、`.primes/` 和
`@skill-wiki/*` 仍出现在当前命令面中。它们是兼容标识，不是当前产品名。
