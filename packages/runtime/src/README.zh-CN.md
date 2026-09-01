# `@aoe/runtime`

这个兼容 Scope Package 负责 Kernary 不可变 Corpus 的激活与 Projection 读取。
它不编译 Source、不执行 Retrieval，也不运行 Action。

| Module | Contract |
|---|---|
| `corpus-snapshot.ts` | 解析 Manifest，验证 Protocol/IR/Emitter 兼容与 canonical content digest，拒绝不安全 Path/File，并返回稳定 `SnapshotRef` |
| `atom-loader.ts` | 读取兼容 `_index.xml` 与每 Unit `atom.yaml`，解析声明的 Projection artifact，并把 Deprecated Unit 排除在 Active selection 外 |

`src/index.ts` 是唯一 Public import surface，Consumer 不应直接导入内部 Module
Path。

Compiler 与 Bundle 创建不可变 Artifact；Runtime 只验证和读取；Query Engine
产生 Selection Plan；Projection Engine 读取通过 Admission 的 Projection；Action
Runtime 负责受控执行与 Event evidence。

`atom-loader` 名称与 Atom-shaped artifact 属于 v1 兼容格式。AOE Core 使用领域
无关 Unit IR，不拥有固定 Atom kind list。通用 MCP Transport、Bundle Finalizer、
CLI Diagnostic 与 Frontend Design Domain Package 都复用同一组 Loader；另写一套
Transport-specific Snapshot Loader 会破坏 Contract。
