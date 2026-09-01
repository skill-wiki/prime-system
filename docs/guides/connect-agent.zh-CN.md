# 连接 Agent

本指南把 Agent 从“我有一个领域 Package”带到“我可以提问并得到经过验证的
答案”。同一个 Runtime 可以嵌入进程、挂载为 MCP Server，或通过 HTTP 提供服务。

## 开始前

你需要由同一个 Release 构建出的两样东西：

- 声明类型、关系、Projection 和 Action 的 Model Package；
- 带 Manifest、Lock，以及（如要求）Signature 的 Corpus Snapshot。

如果 Model 和 Bundle 不匹配，AOE 会拒绝启动。在 Agent 连接前修复这件事，
比它缓存错误结果后再排查容易得多。

## MCP：一条命令连接

通用 MCP Server 读取已编译的 Artifact，不在请求时编译 Source，也不会猜测你
想使用哪个 Domain Package。

```bash
AOE_CORPUS_DIR=/absolute/path/to/corpus/dist \
AOE_MODEL_DIR=/absolute/path/to/model \
bun packages/mcp-server-core/src/index.ts
```

Server 提供三个核心工具：

| Tool | 用途 |
|---|---|
| `aoe_query` | 根据自然语言请求检索 Projection |
| `aoe_plan` | 不加载内容，查看排序、约束、关系与预算 |
| `aoe_resource` | 解析一个精确的 Projection URI |

每个请求都会根据加载的 Model 与 Snapshot 检查。缺少检索信号、未知 Projection、
Visibility 违规、Provider 不可用或 Digest 不匹配时，返回诊断/拒绝，而不是空成功。

### MCP Client 配置

把 MCP Client 指向 Server，并在环境配置中传入两个绝对路径。Model 与 Corpus 必须
来自同一个 Release；不要只替换其中一个而继续使用旧的另一个。

## Embedded SDK

当 Agent 和 Runtime 在同一个进程中时使用 SDK。Client 面保持很小：

```ts
const client = new PrimeClient({ transport });

const plan = await client.plan({
  corpus: 'com.example/support',
  query: '影响 checkout 的未关闭事故',
  topK: 8,
  projection: 'core',
});

const result = await client.query({
  corpus: 'com.example/support',
  query: '影响 checkout 的未关闭事故',
  topK: 8,
  projection: 'core',
});
```

`plan()` 与 `query()` 使用同一个 Selection contract。`preflight()` 与 `execute()`
使用 Action contract，不会从 Query 继承权限。`events(runId)` 返回一次执行的追加式
证据。

## HTTP

当 Agent 与 Runtime 分离，或多个 Client 共享一个已激活 Snapshot 时使用 HTTP。绑定
Authentication、Tenant/Workspace identity，以及该部署真正需要的 Action Provider。
在 Bearer 与 Policy 配置完成前，让服务只监听 loopback。

HTTP 与 SDK 对齐：snapshot、plan、query、resource、preflight、execute 和 events。
Transport 改变的是 bytes 如何传输，不改变 Relation、Constraint 或 Action 的含义。

## 什么时候需要 Domain Skill

Domain Package 可以附带 Skill，教 Agent 使用领域术语、提出更好的问题，或编写新的
Unit。Skill 是边界上的指南；Model 声明、Snapshot 验证、Query 约束和 Action 授权
仍由 Engine 强制执行。

## 生产检查清单

- 在 Release Lock 中固定 Model 版本和 Schema Digest；
- 生产 Snapshot 要求 Manifest 和 Signature；
- 设置明确的 Tenant、Workspace 与 Request Context；
- 只注册该部署需要的 Action Provider；
- 在允许 effectful execution 前执行 Preflight 与 Dry-run；
- 在 Event Store 中保存 Run、Policy、Approval 与 Effect evidence；
- 对 Digest mismatch、Provider 不可用和重复授权失败设置告警。
