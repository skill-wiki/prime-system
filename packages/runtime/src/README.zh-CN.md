# `@skill-wiki/runtime` — 已接入模块与实验性模块

runtime 包同时导出了**生产级原子加载器**（由 MCP 服务器使用）和一组**实验性模块**。实验性模块勾勒出未来 v2"运行时 API"的蓝图，但目前尚未接入任何 CLI 或服务器入口点。测试覆盖了这些模块；生产代码尚未导入它们。

> Method 执行组（`executor.ts`、`evaluator.ts`、`ai-step-executor.ts`、`method-loader.ts`）已于 **2026-08-28 删除**，见下文「已删除」一节。

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
| `corpus-graph.ts` | 原子边的内存图 | `test/corpus-graph.test.ts` |
| `corpus-index.ts` | 按 id/kind/tags 的内存原子索引 | `test/corpus-index.test.ts` |
| `index-manager.ts`（IndexManager） | 缓存 + 使语料库索引失效 | `test/index-manager.test.ts` |
| `domain-plugin.ts`（DomainRegistry） | 领域插件注册；PRIME-SPEC §11 中指出缺失的"领域插件协议" | `test/domain-plugin.test.ts` |
| `skill-bundler.ts` | 将一组原子打包为可部署的 Skill 产物 | `test/skill-bundler.test.ts`（由 `scripts/emit-skill-bundle.ts` 消费） |

### 已删除 2026-08-28 —— Method 执行组

`executor.ts`（PrimeExecutor，697 行）、`evaluator.ts`（EvaluationEngine，361 行）、
`ai-step-executor.ts`（206 行）、`method-loader.ts`（56 行）**已删除**，
连同 `test/executor.test.ts` 与 `test/evaluator.test.ts`。
依据是全仓测量出**零生产消费者**——唯一的引用是本包 `index.ts` 的再导出与那两个测试文件。

这是在执行本文件末尾「路线图条目不再计划则应删除对应模块」那条规矩，不是回退。
计划 §2.3 把它们记为实验模块，§18.4 明确「不直接启用当前实验 Executor/Evaluator」，
§9.7 禁止把「默认全部通过」的模拟 evaluator 当作生产保证。
其职责现由 `packages/action-runtime` 承担（真实的
authorization / policy / idempotency / retry / timeout / event provider 体系）。
按零 shim 原则**直接删除**，未留弃用别名或再导出垫片。

## 为什么这些模块未接入

剩余 6 个实验性模块与当前 MCP + atom-loader 架构不相适：

- **PrimeLoader** 围绕 *Method-prime 执行* 构建——原子体是可逐步评估（可决定/可测量/主观）的序列，在运行时执行。当前 MCP 服务器不*执行* Method prime；agent 阅读其 `core.md` 文本并自行组合输出。接入它意味着用显式步骤机器取代"agent 即作者"模型——那是不同的产品。

- **IndexManager** 加载 `prime.index` JSON（与 v3 `_index.xml` 格式不同），若强行赋予相同角色会与 `atom-loader.loadIndex` 重复。其预期消费者是随附索引的 Skill-bundle 运行时；我们目前没有这个。

- **CorpusGraph / CorpusIndex** 是全局图的内存镜像，具有更丰富的查询 API。MCP 服务器已通过 `_index.xml` + 每原子 `relations` 实现了足够好的图访问。接入这些会减少代码重复，但不会解锁新能力。

  两者仍在硬编码关系名：`corpus-graph.ts:42` 声明了一个 6 名闭集 `LinkVerb` union（还由 `index.ts` 导出），`contradicts()` / `violations()` / `topologicalOrder()` 以及 `corpus-index.ts:327,331,333` 都把关系名当字符串字面量传，而不是读 `RelationDefinition.semantics`。这是 §3.1 的违反，且**无法只在本包内修**——见 `docs/lanes/W3-1-RUNTIME-VERTICAL.md` §2。

- **skill-bundler** 有一个生产调用者：`scripts/emit-skill-bundle.ts`。它用于从原子生成 Skill 产物，但不被 MCP/CLI 运行时路径调用。

这些模块需要一个*用例*来证明集成成本的合理性。DomainRegistry 是实验性模块能够在有真实消费者时毕业的存在证明；对于其他模块，目前没有消费者。

## 路线图指针（各模块何时可能毕业）

1. **IndexManager + CorpusGraph + CorpusIndex** 将在 MCP 服务器的索引内存占用变得不舒适、需要增量更新/磁盘支持缓存时毕业。
2. **skill-bundler** 将在 `prime bundle` 成为面向用户的 CLI 时毕业（目前仅通过 `emit-skill-bundle.ts` 脚本调用）。

如果某个路线图条目不再计划，对应模块应被删除——死导出浪费审查者的时间。
