# 添加 Action 与 Policy

Action 应声明在所属 Model Package 中，不要新增一个带手写领域 schema 的 Engine
命令或 MCP 工具。

Action declaration 需要说明类型化 Input/Output、Capability、Side-effect class、
Idempotency、Approval mode 和 Provider binding。部署再单独注册 Provider。

## 先 Preflight

Preflight 验证 Request Context、Input schema、Principal、Capability、
Precondition、Policy 与 Provider binding。它返回 Effect Plan 和所需审批，不调用
Provider。

Dry-run 用来检查，不用来预占 Idempotency。它不能消耗后续真实执行需要的 Key。

## 执行并保留 Evidence

执行需要在 Tenant/Workspace 内无歧义的 Idempotency key。Retry 必须有界，而且
只在 Action 声明与 Provider 行为允许时进行。Timeout 会阻止 Runtime 接受迟到
结果；有外部副作用的 Provider 还应尽可能支持取消。

Event Store 应保存 Run、Policy 与 Approval provenance、Effect evidence、Error 和
最终状态。Policy 异常或授权失败必须产生可审计终态，不能留下僵尸 Run。
