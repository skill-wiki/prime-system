# 可以用它构建什么

下面每种形状需要的都是同样三件事：应用与 Agent 共享一套词汇、内容的来源可追溯、写操作始终在 Policy 之下。差别只在于有哪些 Type、哪些 Relation 对检索真正重要，以及哪些操作值得成为 Action。

这些只是起步草图。示例里的声明用于说明，不是你必须采用的 schema。

## 客服助手

一个顺着影响面走、而不是从工单文本里猜的助手。

```text
Incident ── affects ──> Service
Incident ── owned-by ─> Team
Incident ── blocks ───> Release
```

这里真正干活的是 Relation。「哪些未关闭的 Incident 影响了 checkout」是一次图遍历，而不是相似度匹配，所以 Selection Plan 能显示它走了哪些关系、排除了哪些。Projection 负责控制响应大小：`summary` 返回标题和严重级别，`core` 加上影响面和负责人，`full` 再加时间线和证据。

值得声明成 Action 的操作：确认、转派、升级、关闭。每个都需要 Capability 和前置条件，其中「关闭」很适合要求审批。

## 合规审查

一次能引用它所读到的确切 Snapshot 的审查。

控制项、证据和例外都是带版本 Release 之下的具名 Unit。由于 Snapshot identity 绑定了 Model、Corpus、Release 与 Digest，三月记录的一个结论，九月可以针对同样的字节复现。许可证和来源信息随内容一起流转 —— 当证据来自第三方时，这一点很关键。

一开始把审查保持为只读。「批准一个例外」是之后才需要声明的 Action，要求审批并追加证据。

## 运维知识库

把危险步骤声明出来、而不是描述出来的 Runbook。

流程成为带前置条件的 Unit。真正改动生产环境的步骤成为 Action，带副作用类别、幂等键和 Policy。这样 Agent 既可以询问回滚流程，也可以请求执行回滚，由 Runtime 决定这个 Principal 是否有权运行。执行前会先返回 Effect Plan，人可以看到将要改变什么。

## 数据目录

数据集、Owner、血缘与访问规则，通过你配置的 Retrieval Profile 取回。

血缘是一个带方向和基数的 Relation，所以「这张表变了会影响什么」是可以回答的。可见性在候选 Provider 拿到数据之前就已生效，这正是私有数据集不会通过某个关系或某个分数泄漏出去的原因。

## 设计系统规范

参考用的 [Frontend Design](https://github.com/kernary-aoe/aoe-frontend-design) Package 发布了 797 个 Unit 的模式、反模式、规则与示例，供 Agent 在写界面代码时查阅。它还附带一个 Validator 和一个可选 Skill，因此在你动手写自己的 Package 之前，它是最值得通读的外部范例。

可以在[注册表](https://kernary-aoe.github.io/zh/marketplace)里浏览它的 Unit，或读[架构走读](https://kernary-aoe.github.io/zh/docs/examples/frontend-design)。

## 什么该成为 Action

Unit 用来描述，Action 用来改变。拿不准的时候，问一句：一次错误的调用是否需要审计记录。如果需要，就把它声明成 Action，让它经过 Capability、Policy、幂等性与审批检查并追加证据。Selection Plan 可以推荐一个 Action，但它无法授予执行它的能力。

## 接下来

- [Package 模型](../concepts/package-model.zh-CN.md)：声明这些草图隐含的 Type 与 Relation。
- [Action 与 Policy](./actions-and-policies.zh-CN.md)：写入路径。
- [连接 Agent](./connect-agent.zh-CN.md)：把结果挂载起来。
