# 术语表

AOE 文档中用到的术语，以及完整定义它们的页面。标识符与契约名保留英文，避免出现第二套技术词汇。

## 产品与 Package

**AOE** —— 产品与引擎家族，Agent Ontology Engine 的简称。

**Agent Ontology Engine** —— 产品类别：面向外部领域模型与语料的编译器和运行时。见 [AOE 是什么](../concepts/what-is-aoe.zh-CN.md)。

**Model Package** —— 领域 schema 与行为的外部声明：Type、Field、Relation、Projection、Retrieval Profile、Function、Action、Policy、Validator 与 Migration。见 [Package 模型](../concepts/package-model.zh-CN.md)。

**Corpus Package** —— 针对某个模型区间发布的外部 Unit、素材、来源、许可证策略与发布配置。

**Adapter Package** —— 外部来源或 Provider 集成。它可以新增 Importer、搜索 Provider、Validator、评测 Provider 或 Action Provider，但不能往模型里新增 Type 或 Relation。

**Domain Package** —— Model、Corpus、Adapter，加上可选 Tools 与可选 Skill 组成的可部署组合。这是读者或 Agent 真正安装的边界。

**Registry** —— Model、Corpus、Adapter、Domain 与 Plugin Package 的发现与分发服务。本站上的注册表是静态发现页面，不是 Registry API。

## 内容与编译

**Unit** —— 与领域无关的源项与 IR 项。Model Package 可以给一个 Unit 更具体的类型名，Core 不需要事先知道这个名字。

**Projection** —— 由模型定义的 Unit 视图。`summary`、`core`、`full` 等层级各自带有 token 目标。

**Snapshot** —— 身份经过验证的不可变语料 Release。见 [编译与 Snapshot](../concepts/compilation-and-snapshots.zh-CN.md)。

**Snapshot identity** —— tenant、corpus、release 与内容摘要的绑定，Runtime 在服务前会重新计算它。

**model.lock** —— 生成文件，记录语料编译时解析到的确切模型版本与 schema 摘要。不要手工编辑。

**Manifest** —— 生成的 `corpus.manifest.json`，描述一个 Release 及其摘要。同样是生成物，同样不要手工编辑。

**IR** —— Compiler 产出的稳定中间表示。Core 固定 IR 与声明 meta-schema，一切领域相关的东西都留在 Package 里。

## 查询与执行

**Retrieval Profile** —— 模型声明的候选生成器、特征、约束与重排器配置，Query 会针对它求值。

**Selection Plan** —— Query 的结果。它记录选中的 Unit、分数贡献、约束决策、Relation 的展开或排除、Projection 加载、预算消耗与诊断信息。见 [Selection 与 Execution](../concepts/selection-and-execution.zh-CN.md)。

**Action** —— 由模型声明、受 Policy 门控的操作。它定义输入、输出、Capability、前置条件、Policy、审批模式、幂等性与证据。

**Execution Plan** —— Action 真正执行之前返回的预检效果与所需审批，也称 Effect Plan。

**Principal** —— 请求代表的身份。

**Capability** —— 请求某个特定 Action 所需的权限。

**Idempotency** —— 同一幂等键重复调用 Action 不会重复产生效果的保证。

**Event Store** —— Action 运行记录与证据的只追加存储，使进行中、等待审批、已完成、失败、超时与重放等状态彼此可区分。

**Evidence** —— 保留下来的证明：一个 Action 做了什么，以及是什么授权了它。

## 面向 Agent

**Skill** —— 可选的、面向 Agent 的工作流或指令层。Skill 可以教 Agent 什么时候该请求某个 Action。它不是 schema、不是 Package 边界、也不是授权机制，并且绕不过 Action Runtime。

**MCP** —— Model Context Protocol，三种 Transport 之一。见 [MCP Transport](./mcp-transport.md)。

**Transport** —— 客户端接触 Runtime 的方式：嵌入式 SDK、MCP 或 HTTP。三者共享同一套 Query、Plan 与 Action 契约。见 [HTTP 与 Registry](./http-and-registry.md)。

## 值得守住的区分

**Unit** 是中立的运行时项，类型名属于 Model Package 的事。**Selection Plan** 可以推荐一个 Action，但无法授予执行它的能力。**Domain Package** 是产品边界，引擎 Package 是它的实现层。

不要把某个示例领域的类型数量、检索轴或工具当成普适行为来讲。当一个细节是领域相关的，就把它归属到拥有它的 Package。写作者在新增术语前，请先读[术语规范](https://github.com/kernary-aoe/aoe-engine/blob/main/docs/style/terminology.md)。
