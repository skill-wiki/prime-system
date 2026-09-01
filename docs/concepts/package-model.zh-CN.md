# Package 模型

当你的领域不只是几份文档，而是需要有名字的对象、明确的关系、可预测的检索
和安全的操作时，AOE 才真正有用。Package 是你负责、发布和升级的单位：
它告诉 AOE 领域是什么、哪些知识属于它，以及 Agent 可以请求哪些操作。

## 你可以使用的四类 Package

```text
Model Package ─────── 领域词汇与行为
Corpus Package ────── 领域知识与证据
Adapter Package ───── 外部来源 / Provider 连接
Domain Package ────── 由以上部分组成的可部署产品
```

原型阶段可以放在一个仓库里；当 Model、数据和 Provider 由不同团队负责时，
再分别发布即可。

## Model Package：描述你的领域

Model Package 回答：“这里可以有什么？可以做什么？”它声明：

- **类型与字段**：应用可以存储或解析的对象；
- **Relation**：方向、基数、遍历、选择、加载顺序、冲突处理和环策略；
- **Projection**：`summary`、`core`、`full` 各层返回哪些字段，以及 token target；
- **Retrieval**：Candidate generator、Feature、Constraint 和 Reranker；
- **Function 与 Action**：纯计算与改变状态的操作；
- **Policy 与 Capability**：谁可以请求 Action，以及需要满足什么条件；
- **Validator 与 Migration**：如何检查输出，如何演进 Release。

这些声明本身是数据。AOE 用 meta-schema 验证它们，并在 Model Lock 中记录
确切版本与 schema digest；引擎不会内置一套所有领域都必须复用的业务类型。

### 一个简单的心智模型

假设你在构建客服助手，Model Package 可以声明：

```text
Incident ── affects ──> Service
Incident ── owned-by ─> Team
Incident ── blocks ───> Release
```

它还可以声明 `summary` 返回标题和严重级别，`core` 增加影响范围与负责人，
`full` 再增加时间线和证据。同一个 Engine 也可以编译完全无关的 Recipe 或
Compliance Model。

## Corpus Package：发布你的知识

Corpus Package 回答：“哪些材料被针对这个 Model 发布？”它拥有：

- Source Unit 与资产；
- Corpus identity 及兼容的 Model range；
- Provenance、署名与 license metadata；
- Visibility 与发布策略；
- Evaluation fixture 与 golden query；
- Release 版本、签名配置和证据。

人编辑的是 Source，构建后得到不可变 Snapshot：

```text
corpus/sources/
      │
      ├─ normalized Units
      ├─ model-defined projections
      ├─ _index.xml
      ├─ corpus.manifest.json
      └─ model.lock
```

不要手工编辑这些生成物。Runtime 在服务 Unit 前会重新计算并检查 identity 与
content digest。

## Adapter Package：连接外部世界

Adapter Package 可以连接来源目录、搜索 Provider、Validator、Evaluation Provider
或 Action Provider。它可以增加集成，但不能悄悄向 Model Package 增加类型或关系。
这样外部 Provider 才可以替换，权限也能被清楚地看见。

## Domain Package：交付一个可用体验

Domain Package 把这些部分组合成 Agent 可以使用的产品：

```text
domain-package/
├── model/       # 领域契约
├── corpus/      # 版本化知识
├── adapters/    # import 与 provider
├── tools/       # 可选领域工具
└── skills/      # 可选 Agent 使用指南
```

Skill 是可选的说明层：可以教 Agent 如何提问、如何编写 Package，但不能替代
Model、授予 Capability，也不能绕过 Action Policy。

## 版本与 Owner

Model 与 Corpus 各自拥有版本。Corpus 声明它适用的 Model range，Compiler 把
最终解析到的确切 Model 写入 `model.lock`。因此在挂载 Release 前，Host 可以确认：

1. 这是 Corpus 期望的 Model 吗？
2. Snapshot 完整且没有被篡改吗？
3. 返回的 bytes 属于谁，许可证是什么？

发布流程请阅读[编译与 Snapshot](./compilation-and-snapshots.zh-CN.md)。要看完整的
外部 Package，请参考
[Frontend Design Domain Package](https://github.com/skill-wiki/kernary-frontend-design)。
