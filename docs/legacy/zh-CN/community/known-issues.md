# 已知问题 — v0.1.0

本文记录 v0.1.0 随附的已知问题，每个问题均附有跟踪工作项和计划修复版本。列表简短且如实呈现：如有本文未涵盖的问题，请提交 Issue。

## 类型系统

### `tsc --noEmit` 在所有包中正常退出

**状态**：已解决  
**严重程度**：不适用

```
bun test           # 448 通过 / 0 失败 / 1366 个 expect() 调用
```

### 测试文件通过 `.ts` 扩展名导入

**状态**：已知，延后处理
**严重程度**：外观问题

`tsconfig.json` 启用了 `allowImportingTsExtensions`，以支持测试文件将同级模块以 `./foo.ts` 形式导入。这是 Bun 解析器所要求的，但意味着测试文件不符合严格 ESM 无扩展名约定。生产源文件使用不带扩展名的桶导入，不受影响。

## 注册中心

### HTTP 注册中心是自建存根，不是公共服务

**状态**：v0.1.0 的设计决策
**严重程度**：已在 `docs/zh-CN/registry.md` 中说明

`scripts/registry-server.ts` 和 `packages/registry/` 中的注册中心服务器是适合自建的可用参考实现，具备：

- `GET/PUT /atoms/:id.prime` HTTP 路由
- SQLite 持久化存储
- 单一共享 bearer token 用于写入权限
- 端到端往返测试

**不具备**：

- 按命名空间的鉴权（一个 token 控制整个注册中心）
- 安装时的 semver 解析
- 镜像或联邦
- 审计日志、限流或签名

公共托管注册中心列入 v0.5 路线图。在此之前，建议组织自建。使用 `AOE_REGISTRY` 环境变量或 `--remote <url>` 将 `prime install` / `prime publish` 指向你自己的服务器。

### `prime decompose` CLI 是指针命令

**状态**：v0.1.0 的有意设计

CLI 子命令指向 `skills/prime-decompose/` 中由 agent 驱动的 `prime-decompose` Claude Code 技能。

如果你有要分解的 SKILL.md，请使用该技能——而非正则。

## 验证器

### L2（语义）校验器需要手动开启并提供 API Key

**状态**：设计决策

L1（结构）和 L3（跨原子一致性）以确定性方式运行，无需网络调用。L2 调用小型 LLM 来检查语义，例如事实置信度校准和规则可判定性——在典型配置下，每个原子的成本约为 USD 0.0001。

L2 需手动开启：设置 `DEEPSEEK_API_KEY`（或在 `packages/compiler/src/ai-client.ts` 中配置的其他提供商 Key），并向构建脚本传递 `--enable-l2-llm`。否则原子默认由作者保证语义有效性。

## 示例

### 示例语料库未签名，且不随附 `compiled/` 构建产物

三个示例语料库（`examples/hello-world`、`examples/recipes`、`examples/coding-style`）仅随附 `primes/sources/`。从仓库根目录运行 `bun run compile-examples` 可为每个示例填充 `primes/compiled/`。CI 在每次推送时执行此操作。

构建产物不随附 `examples/`：随附会使每次源码变更时 `git diff` 产生噪音。
