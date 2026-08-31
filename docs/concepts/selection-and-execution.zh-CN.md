# Selection 与 Execution

读取知识和改变状态在 Kernary 中是两个独立 Contract。

## Selection Plan

Query Request 按外部 Retrieval Profile 执行。Candidate generator 可以使用
Lexical、Facet、Graph 或 Plugin signal。Feature、硬约束、软约束、Relation
semantics、Reranking、Projection、load order 和 token budget 最终形成
Selection Plan。

Plan 会记录选中的 Unit、Score contribution、Constraint decision、Relation
展开或排除、Projection load、Budget 使用和诊断。Visibility 在 Candidate
Provider 接触数据前执行，避免 Private Unit 通过 Relation 或分数泄漏。

## Execution Plan

Action 从 Model declaration 与 Request Context 开始。Runtime 验证 Input、
Principal、Capability、Precondition、Provider binding、Side-effect class、
Idempotency 和 Policy。Preflight 只返回 Effect Plan，不执行 Provider。

只有满足 Policy 或人工审批后才执行。Run 与 Evidence 追加到 Event Store，使
in-flight、awaiting-approval、completed、failed、timed-out 和 replayed 状态可以
被准确区分。

Selection Plan 可以推荐 Unit 或 Action，但不能授予执行 Capability。Skill 可以
教 Agent 什么时候申请 Action，却不能绕过 Action Runtime。
