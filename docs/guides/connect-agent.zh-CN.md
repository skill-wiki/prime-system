# 连接 Agent

只有在 Bundle 已验证、并且拿到生成 `model.lock` 的精确 Model Package 后，才把
它连接到 Agent。

## MCP

通用 MCP Server 读取编译后的 Snapshot。它不在请求期编译 Source，也不会隐式
导入某个 Domain Package。

```bash
PRIME_DIR=/absolute/path/to/corpus/dist \
PRIME_MODEL_DIR=/absolute/path/to/model \
bun packages/mcp-server-core/src/index.ts
```

这两个路径目前仍使用兼容环境变量名。Model lock、Manifest 或 Content digest
不匹配时，Server 会 Fail closed。

## HTTP 与 Embedded SDK

HTTP Server 和 SDK 暴露相同的 Snapshot、Plan、Query、Resource、Action 与
Event contract。应因为部署需求选择 Transport，不要在 Transport wrapper 中复制
领域逻辑。

生产使用前，需要绑定 Authentication、Request Context、Tenant 与 Workspace
identity，并且只注册部署真正需要的 Action Provider。Provider 未绑定或 Policy
缺失时应明确拒绝，不能返回空成功。

Domain Package 可以附带 Skill，向 Agent 说明 Query Profile、工具或 Authoring
workflow。Skill 是可选层；没有它，SDK、MCP 与 HTTP 仍然是完整接口。
