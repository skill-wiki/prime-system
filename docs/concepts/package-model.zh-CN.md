# Package 模型

Kernary 把领域语义留在引擎外。一个部署由不同 Owner、不同发布规则的 Package
组合而成。

## Model Package

Model Package 声明领域 vocabulary 与行为：

- 类型与字段；
- Relation 的方向、基数、遍历、选择、加载顺序、冲突和环策略；
- Projection 与 token target；
- Retrieval profile、generator、feature、constraint 与 reranker；
- Function、Action、capability、approval 与 policy；
- Validator 与 migration。

引擎只用 meta-schema 验证这些声明，不枚举 Ticket、Rule、SecurityControl 或
任何生产类型。

## Corpus Package

Corpus Package 拥有针对某个模型发布的材料：

- Source Unit 与资产；
- Corpus identity 和兼容模型范围；
- Provenance 与 license metadata；
- Visibility 与发布策略；
- Evaluation fixture；
- Release 与签名配置。

编译输出不是 Source。`_index.xml`、Unit Projection、
`corpus.manifest.json`、签名和 `model.lock` 都是生成物。

## Adapter 与 Domain Package

Adapter Package 连接外部目录、API、Validator、搜索 Provider 或 Action
Provider。它不能向 Core 添加领域语义。

Domain Package 把 Model、Corpus、Adapter、工具和可选 Agent Skill 组合成一个
有人维护的产品边界。Frontend Design 就是其中一个 Domain Package；它的
Persona、六轴检索、HTML Validator 和 Scout Adapter 都属于该领域。

这种拆分让 Model 与 Corpus 能在声明的兼容范围内独立发布，让新领域无需修改
Parser 或 Runtime，也让 Skill 改善 Agent UX 时不会顺便获得 schema 或写权限。
