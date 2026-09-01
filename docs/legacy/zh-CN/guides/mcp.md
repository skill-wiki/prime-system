# MCP server

这一页讲 `packages/mcp-server-core/` —— 这个仓库自带的**通用** MCP
server。它故意写得很小（约 200 行），对任何编译好的 Prime corpus 暴露
一个工具：`aoe_query`。

如果你要更丰富、领域感知的 MCP（多工具、意图识别、多轴检索），那个
住在 corpus 仓库，不在这里。文末有指针。

---

## 它解决什么问题

一个编译好的 corpus 是一棵目录：

```
compiled-v3-final/
├── _index.xml                       # agent 主要看的索引（约 3 KB）
├── @community/
│   ├── persona-stripe/
│   │   ├── summary.md               # 约 30 token
│   │   ├── core.md                  # 约 150 token
│   │   ├── full.md                  # 约 400 token
│   │   └── meta.json                # 边 + tag + version
│   ├── pattern-card-elevated/...
│   └── …
```

Agent 拿到的不是这棵目录，而是一个跑在 stdio 上的进程，进程暴露一个
工具。工具返回的是**路径**或者投影内容。Agent 再用它自己的 `Read`
工具读它选中的那个文件。

这个反转是核心 —— **MCP server 返回指针，agent 自己解引用**。
所有 atom 内容根本不需要穿过 MCP 边界。边界只用来传结构。

---

## 工具表面 —— `aoe_query`

```typescript
aoe_query({
  scope: "atoms" | "related" | "scout" | "template",
  query?: string,    // 自由文本 —— atoms / scout 用
  id?: string,       // atom id —— related / template 用
  level?: "summary" | "core" | "full",   // 默认 "summary"
  depth?: number,    // related 用，默认 1
  limit?: number,    // 默认 20
}) → {
  results: Array<{
    id: string,                  // "@community/persona-stripe"
    kind: string,                // "persona"
    level: "summary" | "core" | "full",
    path: string,                // 投影 .md 的绝对路径
    summary?: string,            // level === "summary" 时直接 inline
  }>;
  count: number;
  hint?: string;                 // 可选，下一步建议
}
```

四种 scope：

| Scope | 干什么 | Agent 典型用法 |
|---|---|---|
| `atoms` | 在索引上做词法/tag 匹配。 | Agent 拿到 query 字符串后第一个调用。 |
| `related` | 从 `id` 沿边图走，按深度限制。 | 主 atom 选好后找邻居。 |
| `scout` | 给一组「好的起点」—— 几个 `persona`、`principle`、`pattern` atom，提示 corpus 长啥样。 | 冷启动，agent 还不熟悉这个 corpus。 |
| `template` | 返回 `template` kind 的 atom，`full` 级别。 | brief 要求脚手架时。 |

不写。不带检索侧 embedding。全部都是结构化操作 —— 边遍历、kind 过滤、
索引上的 substring 匹配。

---

## Server 实际加载什么

```bash
AOE_CORPUS_DIR=/abs/path/to/compiled bunx @aoe/mcp-server-core
# 或者，本地开发时直接从源码运行：
AOE_CORPUS_DIR=/abs/path/to/compiled bun packages/mcp-server-core/src/index.ts
```

启动时：

1. 把 `<corpus>/_index.xml` 读进内存（几 KB）。
2. `aoe_query` 返回路径时再去懒加载
   `<corpus>/<scope>/<name>/<level>.md`。
3. 在内存里建一张邻接图供 `related` 遍历。

就这些。没 DB，没向量库，没 warm-up。900 atom 的 corpus 启动约 80 ms。

```bash
$ AOE_CORPUS_DIR=./compiled-v3-final bunx @aoe/mcp-server-core
[prime-mcp-core] 899 atoms · 51234 tokens · 12 clusters
[prime-mcp-core] ready · tool: aoe_query · stdio transport active
```

---

## 接进 Claude Code

项目根目录的 `.mcp.json`：

```json
{
  "mcpServers": {
    "skill-wiki": {
      "command": "bunx",
      "args": ["@aoe/mcp-server-core"],
      "env": {
        "AOE_CORPUS_DIR": "/abs/path/to/compiled-v3-final"
      }
    }
  }
}
```

Claude Code 重启后，工具会以 `mcp__skill-wiki__aoe_query` 的名字
出现。Agent 调用时传 `scope: "atoms"`，拿到一组路径，然后用自己的
`Read` 工具去读它要的那个投影。

典型一轮长这样：

```
agent → aoe_query({ scope: "atoms", query: "warm institutional" })
       ← { results: [{ id: "@community/persona-stripe", ...,
                        path: "/.../@community/persona-stripe/summary.md" }] }
agent → Read("/.../@community/persona-stripe/summary.md")
       ← "Stripe register — 克制色板、宽裕字距..."
agent → aoe_query({ scope: "related",
                      id: "@community/persona-stripe",
                      depth: 1 })
       ← { results: [{ id: "@community/rule-contrast-aaa", ...,
                        path: "/.../@community/rule-contrast-aaa/core.md" }, …] }
agent → 按需 Read 它要的几个
```

完整内容是 agent 自己读的；MCP 边界永远只过路径和很短的 summary
字符串。带宽和 token 成本都受 agent 自身的「读取节制」限制，不是
server 控制。

---

## 接进其他 MCP 客户端

MCP 协议是 stdio（或 SSE）上的 JSON-RPC。任何符合协议的客户端都行。

**Continue**（`config.yaml`）：

```yaml
mcpServers:
  - name: skill-wiki
    command: bunx
    args: ["@aoe/mcp-server-core"]
    env:
      AOE_CORPUS_DIR: /abs/path/to/compiled
```

**Cline / Cursor / 自己的 runtime**：把 `bunx @aoe/mcp-server-core`
起成子进程，设置 `AOE_CORPUS_DIR` 环境变量，用 `Content-Length` 帧化的 JSON-RPC
通信。`mcp-server-core` 依赖上游的 `@modelcontextprotocol/sdk`，所以任何
符合 MCP v1 的客户端都能直接用。

**编程式接入**（自己的 runtime）：

```typescript
import { spawn } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";

const transport = new StdioClientTransport({
  command: "bunx",
  args: ["@aoe/mcp-server-core"],
  env: { ...process.env, AOE_CORPUS_DIR: "/abs/path/to/compiled" },
});
const client = new Client({ name: "my-agent", version: "0.1.0" }, {});
await client.connect(transport);

const out = await client.callTool({
  name: "aoe_query",
  arguments: { scope: "atoms", query: "warm institutional", limit: 5 },
});
console.log(JSON.parse(out.content[0].text));
```

---

## 「Agent 读路径」模型

这个 server 最关键的一个设计选择：**内容不在工具响应里**。工具返回
路径（或者 `summary` 级时一句话）。Agent 已经有 `Read` 工具，自己去
读它真要的那部分。

为什么这件事重要：

1. **MCP 流量受控。** 不管 query 命中多少 atom，`aoe_query` 调用
   就几百字节。token 成本落在 agent 后续的 `Read` 调用里 —— 而那是
   agent 自己看得见、自己能停下的地方。
2. **不锁投影。** Server 不知道这一轮该用哪个层级 —— 只有 agent
   知道。返回路径让 agent 可以对每个 atom 自由选 `summary` /
   `core` / `full`。
3. **天然缓存。** 文件系统有缓存；MCP 响应不需要。
4. **可以和别的工具组合。** Agent 可以把 `aoe_query` 结果接进
   `Grep`、`Edit`、其他 toolbelt 里的东西。Atom 本质就是文件。

这个反转就是为什么 200 行 server 够用。

---

## 它**不**做的事

- **不做意图分类。** 「brief 进 → IntentObject 出」是领域逻辑。
  前端 corpus 自己做；通用核心不做。
- **不做多轴检索。** 给前端 brief 选「register、pattern、motion、
  type、color、rules」六轴是领域专属的 composition 逻辑。通用的
  `aoe_query` 只按 query 字符串和边图返回；按轴排序是 wrapper 的事。
- **不做 L5 输出校验。** validator runtime（`packages/validator-core/`，
  v0.2 roadmap）是独立关注点；MCP server 不 import 它。
- **不写。** 从 MCP 角度看，atom 是只读的。要改就改 `.prime` 源然后
  重跑 `prime compile`。
- **不做认证。** stdio 传输默认是本机信任。要带认证的远程 MCP，自己
  在 SSE 桥后面加一层；核心不带。

---

## 领域专属 MCP wrapper

前端 corpus 仓库（`prime-corpus-frontend`）会**包装** `mcp-server-core`，
加 5 个工具（按 `FRONTEND-DESIGN-DOMAIN-v1.md` §5）：

| 工具 | 比通用核心多了什么 |
|---|---|
| `prime_compile` | brief → IntentObject → 6 轴检索方案 + `must_include`/`must_avoid` 契约。 |
| `aoe_query` | 形状和核心一样；wrapper 把 `scope` 扩成前端专属的 `mandate`、`checklist`、`gallery` 等。 |
| `prime_intent` | 只跑 Layer 1 —— `brief → IntentObject`，不做检索。 |
| `prime_resolve` | atom id + 投影层级 → 完整内容。 |
| `prime_validate` | Layer 5 —— 校验生成的 HTML 是否符合契约。 |

这些工具编码的是前端设计领域规则。它们不是协议的一部分。要给你自己的
领域写 wrapper，看 [corpus-authoring.md](./corpus-authoring.md) §6。

System 仓库故意停在 `aoe_query`。这一个工具加上 agent 的 `Read`，
足以表达 Prime corpus 上任意只读检索模式。

---

## 运维细节

- **日志走 stderr**（server 把结构化启动日志打到 stderr；
  stdout 留给 MCP 协议帧）。
- **corpus 变化不会自动 reload** —— 改完 `prime compile` 后请重启
  server。文件监听模式在 roadmap 上。
- **多 corpus**：在 `.mcp.json` 里注册多个 server，名字不一样
  （`skill-wiki-frontend`、`skill-wiki-cooking`……）。它们之间不共享
  状态。
- **内存**：1000 atom 的 corpus 常驻约 6 MB。server 长开没问题。
- **崩溃语义**：server 无状态。挂了重启就行；磁盘上没东西需要保护。

---

## 快速冒烟测试

```bash
# 起 server（在 prime-system 仓库根目录）
$ AOE_CORPUS_DIR=examples/hello-world/primes/compiled \
    bun packages/mcp-server-core/src/index.ts &
[prime-mcp-core] 5 atoms · 348 tokens · 1 clusters
[prime-mcp-core] ready · tool: aoe_query · stdio transport active

# 发一个工具调用（任何 MCP 客户端都行；这里用 SDK）
$ node --experimental-transform-types <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";

const transport = new StdioClientTransport({
  command: "bun",
  args: ["packages/mcp-server-core/src/index.ts"],
  env: { ...process.env, AOE_CORPUS_DIR: "./examples/hello-world/primes/compiled" },
});
const client = new Client({ name: "smoke", version: "0.1.0" }, {});
await client.connect(transport);

const r = await client.callTool({
  name: "aoe_query",
  arguments: { scope: "atoms", query: "tea", limit: 3 },
});
console.log(r.content[0].text);
EOF

# 预期：
# {
#   "results": [
#     {
#       "id": "@example/method-make-tea",
#       "kind": "method",
#       "level": "summary",
#       "path": "/.../@example/method-make-tea/summary.md",
#       "summary": "水加热到 100°C，浸泡 3-5 分钟。"
#     },
#     ...
#   ],
#   "count": 2
# }
```

如果你看到 `"count": 0`，多半是 `--corpus` 指到了 `primes/sources/`
而不是 `primes/compiled/`。Server 只读编译产物。

---

## 指针

- `docs/zh-CN/cli.md` —— 怎么编译 corpus。
- `docs/zh-CN/corpus-authoring.md` §6 —— 什么时候、怎么给这个核心写
  领域专属 wrapper。
- `spec/FRONTEND-DESIGN-DOMAIN-v1.md` §5 —— 前端 corpus 的 5 工具表面，记在这里
  方便交叉引用（这些工具住在 `prime-corpus-frontend`，不在本仓库）。
