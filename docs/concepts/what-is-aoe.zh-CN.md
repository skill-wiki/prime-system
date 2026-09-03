# AOE 是什么

AOE 把你声明的领域编译成一个 Runtime，供应用或 Agent 查询与执行。词汇和知识归你所有；引擎负责编译、Snapshot 身份、检索，以及写操作的授权路径。

名字本身就是类别：Agent Ontology Engine。这里的本体是工程意义上的那种，一组声明出来的 Type、Field 和 Relation，你的软件其实早已隐含了它们。AOE 要求你把它写下来一次，写成应用和 Agent 都能读的形式。

## 它针对的问题

多数系统交给 Agent 的，要么是塞满文档的 Prompt，要么是建立在文本切片上的相似度索引。两者返回的都是段落。它们都回答不了：这个对象是什么、它和哪些对象有关系、答案来自哪个 Release，以及 Agent 是否有权修改它。

这个缺口会变成一些熟悉的工作：每个领域都要再搭一套检索栈；Agent 从检索到的段落里临时编出一个工具调用；语料一变，排序结果就无法复现；以及无法证明是哪些字节产生了这个答案。

## 你会得到什么

一次构建产出一个自带身份的 Snapshot：

```text
Model Package + Corpus Package
              │
              ▼
       compile · check · sign
              │
              ▼
       verified runtime snapshot
          │                 │
      query / plan       action / evidence
```

Query 返回的是 Selection Plan，而不是一个列表。这份 Plan 记录了：选中的 Unit、决定它们排序的分数贡献、生效的约束决策、哪些 Relation 被展开或排除、加载了哪一级 Projection、消耗了多少预算，以及作答的 Snapshot 身份。你的应用可以记录这份 Plan、在两个 Release 之间比对它、并为它写测试。

写操作走声明过的 Action。Runtime 会校验输入、Principal、Capability、前置条件、Provider 绑定、副作用类别、幂等性与 Policy，然后先返回一份 Effect Plan，此时还没有执行任何东西。执行要等到所需审批通过，运行记录与证据随后追加进 Event Store。

## 什么时候该用

如果你的领域里有具名对象、有对检索确实重要的关系、有必须受治理的操作，AOE 就合适。一个包含 Incident、Service、Team、Release 的客服领域是合适的；一个有控制项和证据的合规领域也是；一个希望把危险步骤变成声明式 Action、而不是让 Agent 现场发挥的运维领域同样合适。

如果单一的非结构化语料加相似度检索已经能回答你的问题，或者领域里根本没有被写下来的东西，或者你今天就需要一个托管服务，那它并不合适 —— 这个站点上的注册表是静态的发现页面，不是 Registry API。

## 引擎不替你决定什么

Core 只固定声明 meta-schema 和稳定 IR。Atom kind、字段名、关系名、Retrieval Profile、Action 和 Validator 都是你 Model Package 里的数据。内部没有一份业务类型清单，所以客服模型、菜谱模型和设计系统语料走的是同一条编译路径。

注册表里的参考 Package，包括 797 个 Unit 的 Frontend Design 语料，都是针对这些契约发布的外部 Package。把它们当作可运行的范例来读；当你的领域不同时，替换掉它们。

## 接下来读什么

- [Package 模型](./package-model.zh-CN.md)：你可以拥有的四种 Package。
- [编译与 Snapshot](./compilation-and-snapshots.zh-CN.md)：一个 Release 如何被构建和验证。
- [Selection 与 Execution](./selection-and-execution.zh-CN.md)：读写两份契约的细节。
- [可以用它构建什么](../guides/use-cases.zh-CN.md)：几个具体的领域形状。
- [术语表](../reference/glossary.zh-CN.md)：这些页面里用到的术语。
- [构建你的第一个领域 Runtime](../start/index.zh-CN.md)：跑一遍五分钟路径。
