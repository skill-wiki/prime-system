# `@skill-wiki/runtime` — 已接入模块与实验性模块

runtime 包同时导出了**生产级原子加载器**（由 MCP 服务器使用）和一组**实验性模块**。实验性模块勾勒出未来 v2"运行时 API"的蓝图，但目前尚未接入任何 CLI 或服务器入口点。测试覆盖了这些模块；生产代码尚未导入它们。

## 已接入（生产）

| 模块 | 调用者 | 用途 |
|---|---|---|
| `atom-loader.ts` | `mcp-server/index.ts`（loadIndex, loadAtomMeta, resolveProjection, resolveCollection） | 读取 `_index.xml`；解析投影层级路径；将废弃原子路由到独立桶，使检索永不返回它们。 |
| `domain-plugin.ts`（DomainRegistry）+ `domain-config.ts`（discoverDomains） | `mcp-server/index.ts` | 领域感知排序：在启动时从 `domain.yaml` 文件加载领域（无硬编码领域）；`rankV3Atoms` 对标签/描述与 brief 引用领域匹配的原子提升得分。 |

## 实验性（仅测试——未接入）

这些模块构成了一个计划中的执行与领域运行时，尚未接入 MCP 服务器或 CLI。它们有单元测试和稳定的公开 API，但没有生产调用者。请将其视为"设计已验证，尚未发货"。如果你从生产代码中导入了任何这些模块，请更新本 README 以保持接入记录的诚实。

| 模块 | 预期功能 | 测试文件 |
|---|---|---|
| `loader.ts`（PrimeLoader） | 从目录树解析并加载 Prime 产物 | `test/loader.test.ts` |
| `method-loader.ts` | Method prime 的专用加载器 | （无独立测试） |
| `executor.ts`（PrimeExecutor） | 逐步执行 Method prime | `test/executor.test.ts` |
| `evaluator.ts`（EvaluationEngine） | Rule prime 的谓词/阈值评估 | `test/evaluator.test.ts` |
| `ai-step-executor.ts` | LLM 支持的 Method 步骤执行器 | （通过 executor 测试间接覆盖） |
| `corpus-graph.ts` | 原子边的内存图 | `test/corpus-graph.test.ts` |
| `corpus-index.ts` | 按 id/kind/tags 的内存原子索引 | `test/corpus-index.test.ts` |
| `index-manager.ts`（IndexManager） | 缓存 + 使语料库索引失效 | `test/index-manager.test.ts` |
| `domain-plugin.ts`（DomainRegistry） | 领域插件注册；PRIME-SPEC §11 中指出缺失的"领域插件协议" | `test/domain-plugin.test.ts` |
| `skill-bundler.ts` | 将一组原子打包为可部署的 Skill 产物 | `test/skill-bundler.test.ts`（由 `scripts/emit-skill-bundle.ts` 消费） |

## 为什么这些模块未接入

剩余的 9 个实验性模块构成了一个连贯的**替代运行时模型**，与当前 MCP + atom-loader 架构不相适：

- **PrimeLoader / PrimeExecutor / EvaluationEngine / ai-step-executor** 围绕 *Method-prime 执行* 构建——原子体是可逐步评估（可决定/可测量/主观）的序列，在运行时执行。当前 MCP 服务器不*执行* Method prime；agent 阅读其 `core.md` 文本并自行组合 HTML。接入这些模块意味着用显式步骤机器取代"agent 即作者"模型——那是不同的产品，而非缺少的螺丝。

- **IndexManager** 加载 `prime.index` JSON（与 v3 `_index.xml` 格式不同），若强行赋予相同角色会与 `atom-loader.loadIndex` 重复。其预期消费者是随附索引的 Skill-bundle 运行时；我们目前没有这个。

- **CorpusGraph / CorpusIndex** 是全局图的内存镜像，具有更丰富的查询 API。MCP 服务器已通过 `_index.xml` + 每原子 `relations` 实现了足够好的图访问。接入这些会减少代码重复，但不会解锁新能力。

- **method-loader** 是 Method prime 的专用加载器，命运同 PrimeLoader。

- **skill-bundler** 有一个生产调用者：`scripts/emit-skill-bundle.ts`。它用于从原子生成 Skill 产物，但不被 MCP/CLI 运行时路径调用。

这些模块需要一个*用例*来证明集成成本的合理性。DomainRegistry 是实验性模块能够在有真实消费者时毕业的存在证明；对于其他模块，目前没有消费者。

## 路线图指针（各模块何时可能毕业）

1. **PrimeExecutor + EvaluationEngine** 将在出现需要端到端*运行* Method prime 的工具/子 agent 时毕业（如自动化审计，逐条走完所有 check 并报告通过/失败）。目前 agent 通过阅读 Markdown 非正式地完成这件事。
2. **IndexManager + CorpusGraph + CorpusIndex** 将在 MCP 服务器的索引内存占用变得不舒适、需要增量更新/磁盘支持缓存时毕业。
3. **skill-bundler** 将在 `prime bundle` 成为面向用户的 CLI 时毕业（目前仅通过 `emit-skill-bundle.ts` 脚本调用）。
4. **method-loader** 将与 PrimeExecutor 一同毕业。

如果某个路线图条目不再计划，对应模块应被删除——死导出浪费审查者的时间。
