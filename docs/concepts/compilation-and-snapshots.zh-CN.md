# 编译与 Snapshot

编译是 Release 操作。Runtime 在处理 Query 或 Action 时不会把可变 Source 临时
变成 Artifact。

## Pipeline

1. 解析精确的 Model Package，并计算 semantic digest。
2. 解析 Source syntax，归一化为领域无关 Unit IR。
3. 按已加载模型验证字段与 Relation。
4. 渲染该模型声明的 Projection。
5. 检查跨 Unit Relation 与 Corpus 不变量。
6. 通过原子 staging transaction 生成 Unit artifact、全局 Index、Manifest、
   Lock 和可选签名。
7. 激活前用 strict mode 加载完成的 Snapshot。

相同 Source、Model、Corpus identity 与 Release 输入必须生成相同 bytes。输出
目录不参与 identity。

## Snapshot identity

`model.lock` 绑定精确模型文件与 semantic digest；
`corpus.manifest.json` 绑定全局 Index 和 canonical corpus content digest。
Strict Runtime 会重新计算这些值，并拒绝篡改、缺失 Projection、不安全链接和
非普通文件。

Release date 是显式构建输入。使用 `--release` 或 `SOURCE_DATE_EPOCH`，避免墙钟
时间破坏可复现性。

不要修改编译后的 Unit、Projection、`_index.xml`、Manifest、Signature 或
Lock。应修改所属 Model/Corpus Source，构建新 Release，验证后再激活新的不可变
目录。
