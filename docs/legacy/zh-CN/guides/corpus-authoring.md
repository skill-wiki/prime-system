# 写一个 corpus

这一页给那些想从零起一个 Prime corpus 的人 —— 烹饪、安全策略、ML
评测 rubric、法律条款，什么领域都行。28 种 atom kind 和 14 种边动词
跨领域保持不变。变的是你的 corpus 侧重哪几种、怎么聚簇。

整条路是这样：

1. 挑你这个领域真用得到的 kind。
2. 起 5–10 个 atom 跨 3–4 种 kind 做 bootstrap。
3. 加边（先 `related`，之后逐步上类型）。
4. 编译、查询、迭代。
5. 模式稳定后升级到 composition contract。
6. 可选：写领域专属的 MCP wrapper。
7. 可选：发到 registry。

6 步主线，2 步可选。一个熟手在熟悉领域里跑完整端到端的 40-atom
MVP corpus，大约一个周末。

---

## Step 1 —— 挑 kind

完整的 28 种在 [dsl-quickref.md](../reference/dsl-quickref.md)。
你不会全用上。第一版 corpus 通常用 4–6 种。

启动用的小启发：

| 你的领域主要在讲… | 拿这些 |
|---|---|
| **是什么**（百科类） | `fact`、`term`、`category`、`source` |
| **怎么做**（流程） | `step`、`method`、`tool` |
| **允许什么**（规则 / 评分） | `rule`、`check`、`constraint` |
| **应该是什么感觉**（风格 / 声音） | `persona`、`voice`、`template` |
| **模式**（问题 ↔ 解法） | `pattern`、`anti-pattern` |
| **怎么组织** | `collection`、`taxonomy`、`principle` |

第一版选 3–4 种就够。下个月发现某个边塞不下时再加。**不要**一上来
就给 28 种全都安排上。

真实 corpus 例子：

- **烹饪**（`examples/recipes/`，15 atom）：`fact`（水 100°C 沸腾）、
  `step`（洋葱切薄片）、`method`（出油爆香）、`rule`（酸平衡油）、
  `term`（mise en place）。
- **前端设计**（corpus 仓库，899 atom）：`persona`、`pattern`、
  `rule`、`check`、`template`、`principle`，加 6 种处理长尾。
- **安全策略**（假想，约 50 atom）：`rule`、`check`、`pattern`、
  `anti-pattern`、`term`、`source`、`principle`。

不需要在哪声明你用了哪几种 —— 每个 `.prime` 文件第一行用对应的
declaration 关键字（`rule`、`pattern`、`fact`……）就行，parser 看
关键字。

---

## Step 2 —— 5–10 个 atom 起步

挑一小片领域。**别贪全**。bootstrap 的目的是**摸出你的 atom 想长
成什么样**，不是写教程。

```bash
# 起工作区
$ mkdir -p my-corpus/sources/@me
$ cd my-corpus

# 第一个 atom —— 一个 fact
$ cat > sources/@me/fact-rest-meat.prime <<'EOF'
fact RestMeat {
  id: "@me/fact-rest-meat"
  version: "1.0.0"

  statement: "肉烤好后静置 5–10 分钟让汁水重新分布，可让上桌湿度提升约 10%。"
  confidence: 0.95
  domain: cooking

  related: [
    @me/term-myoglobin,
  ]
}
EOF
```

照样写 5–10 个。你会在三个地方感到摩擦：

1. **命名**。id 应该叫什么？用 `@scope/kind-slug` 约定，slug 写得
   像英文短句。`@me/method-render-bacon` 比 `@me/method-bacon-001`
   好太多。
2. **粒度**。一个 atom 什么时候该裂成两个？发现自己在 body 里写
   "……同时还……"，就拆。一个 atom 回答一个问题。
3. **kind 边界在哪**。「煮面水永远要加盐」是 `rule` 还是 `fact`？
   定一次，全程一致。常用判据：能 check 的是 `rule`；描述性的是
   `fact`。

早编译、早暴露问题：

```bash
$ prime compile sources/@me/fact-rest-meat.prime --dir
✅ Phase 1: Parsed 14 lines, 0 syntax errors
✅ Phase 2: All checks passed
✅ Phase 4: Emitted atom directory
   Tokens: summary=18 core=64 full=104
```

写到约 10 个跑一遍 registry 全量检查：

```bash
$ prime check --registry --dir sources
═══ Prime Registry — Integrity Check
  Atoms checked:   10
  Passed:          10
  With issues:     0
  Pass rate:       100%
```

---

## Step 3 —— 加边

bootstrap 出来的 atom 大概只有 `related` 边，没事。这一步是把那些
边随结构稳定下来**类型化**。

凡是有更具体动词适用的，把 `related` 替换掉：

| 把 `related` 换成… | 什么时候 |
|---|---|
| `requires` | A 加载没意义除非 B 也加载 |
| `enhances` | B 让 A 更好但 A 自己也能站住 |
| `validates-with` | A 的正确性可以通过 B 校验 |
| `specializes` | A 是 B 的更窄版本 |
| `contradicts` | A 和 B 主张相反（编译器 L3 会标记） |
| `conflicts` | A 和 B 不应该一起加载 |

```prime
method RenderBacon {
  id: "@me/method-render-bacon"
  version: "1.0.0"

  // 原来：related: [ @me/fact-rest-meat ]
  // 现在：
  enhances: [
    @me/method-pan-roast-vegetables,    // 培根油是它的输入
  ]
  validates-with: [
    @me/check-bacon-shatter-test,
  ]

  steps: [...]
}
```

`prime check --registry` 会去解析每个边的目标 —— ref 写错就直接
报 error。

新手常见样：所有边都是 `related`。第一个月没问题。第二个月起，至少
30% 的边应该有具体类型。第六个月起，泛化的 `related` 占比应该
低于 10%。

---

## Step 4 —— 编译、查、迭代

可工作的 corpus 有个紧凑的内循环：

```bash
# 改
$ vim sources/@me/method-render-bacon.prime

# 编译
$ prime compile sources/@me/method-render-bacon.prime --dir --output ./compiled

# 查询（通过通用 MCP server）
$ PRIME_DIR=$(pwd)/compiled bunx @prime-lang/mcp-server-core &
$ # ... 在 Claude Code 里问「怎么 render bacon」
$ # ... 或者 CLI 直接看：
$ prime show @me/method-render-bacon
$ prime deps @me/method-render-bacon

# 发现哪里缺，回去改，循环
```

50-atom corpus 的编译耗时约 150 ms。成本花在**思考 atom 该怎么写**，
不在工具。

一个有用的演练：从领域里挑一个真实 brief（比如「怎么煎一块半生熟
牛排」），让 agent 跑你的 corpus，看它通过索引看到的条目对不对。
凡是 agent 不得不退回到自己训练数据的地方，就是你 corpus 的缺口。

---

## Step 5 —— composition contract

模式稳定下来之后 —— 一般在 30–50 个 atom 时 —— 把最中心的几个 atom
（通常是 `persona` / `principle` / `pattern` 之类）升级到带
**composition contract**。Composition contract 就是在 atom 上声明
`must-include` / `must-avoid`，告诉检索器：这个 atom 被加载时，
必须连带加载哪些、必须避开哪些。

```prime
persona MichelinFineDining {
  id: "@me/persona-michelin-fine-dining"
  version: "1.0.0"

  // …常规字段…

  composition: {
    must-include: [
      @me/rule-mise-en-place,
      @me/rule-acid-balance,
      @me/check-plating-discipline,
      @me/principle-restraint,
    ]
    must-avoid: [
      @me/persona-comfort-food,
      @me/anti-pattern-overgarnishing,
    ]
  }
}
```

之后任何检索一旦选中 `persona-michelin-fine-dining`，**必须**同时
浮出那 4 个 must-include atom，**且不能**浮出 2 个 must-avoid 的。
runtime / wrapper 强制这个约束；自己写 MCP wrapper 可以在它上面建
L5 validator。

判断你是不是该上 contract：你能在生成**之前**预先写出 must-include
列表吗？能的话，contract 就是把这份知识固化下来。不能 —— 你的
模式还没稳定，先在 `requires` / `enhances` 这一层多走几轮。

---

## Step 6 —— 领域专属 MCP wrapper（可选，v0.2 roadmap）

通用 `mcp-server-core` 对大多数团队够了。只有当你的检索带**协议
靠 kind + 边表达不出来的领域逻辑**时才需要 wrapper。比如：

- **多轴检索**。「拿到一条前端 brief，在 `register`、`pattern`、
  `motion`、`typography`、`color`、`rules` 六个轴各返回一个 atom」。
  这是 wrapper 的事。
- **意图分类**。「brief 进 → IntentObject 出」。领域分类器，不是
  corpus 操作。
- **输出校验**。「生成的 HTML 满足 composition contract 吗？」
  把 corpus 知识 + 输出解析合起来的 runtime validator。

目前，通用的 `prime_query` 工具覆盖了 atom 搜索、related 边遍历和
projection 级别解析。领域 wrapper 可以通过串联多个 `prime_query` 调用
来组合成更高层次的工作流。

在 `prime_query` 之外添加领域专属 MCP 工具的一等公民 API（例如一个
`legal_check` 工具，能对文本输入跑领域 validator）在 v0.2 roadmap 上。
在此之前，需要自定义工具的领域作者可以起一个独立的 MCP server，通过
`@modelcontextprotocol/sdk` 客户端把 `prime_query` 请求转发给核心
server —— 前端 corpus 仓库的五工具 wrapper 就用的这个模式。

要启动核心 server，使用真实命令：

```bash
PRIME_DIR=/abs/path/to/compiled bunx @prime-lang/mcp-server-core
```

或者写进 `.mcp.json`：

```json
{
  "mcpServers": {
    "skill-wiki": {
      "command": "bunx",
      "args": ["@prime-lang/mcp-server-core"],
      "env": { "PRIME_DIR": "/abs/path/to/compiled" }
    }
  }
}
```

（一等公民扩展 API 的设计草案，请关注 v0.2 milestone —— 设计讨论
在 GitHub Discussions「MCP extension points for domain wrappers」线程。）

---

## Step 7 —— 发布（可选）

两种情形需要 registry：

1. **多机** —— 笔记本上写，服务器上跑 agent。
2. **多人** —— 团队需要共享 canon。

不管哪种，[docs/zh-CN/registry.md](../reference/registry.md) 完整讲了
自托管。最小套路：

```bash
# 在 registry 主机上
PRIME_REGISTRY_TOKEN=secret bun run scripts/registry-server.ts \
  --port 7700 --root /var/lib/prime-store

# 在每个写 / 跑的机器上
export PRIME_REGISTRY=https://prime.team.example
export PRIME_REGISTRY_TOKEN=...

# 发布
prime publish sources/@me/method-render-bacon.prime

# 拉（在 runner 上）
prime install @me/method-render-bacon --dir ./sources
```

不一定非要 registry —— `git` 也行。Registry 多给你的是版本语义和
按 `--remote` 自动解析依赖。

---

## 模式：MVP corpus 的形状

一个能用的起步 corpus 大致有：

- **5–10 个 `fact` / `term`** —— 你领域的词汇表。
- **3–5 个 `rule` 或 `check`** —— 可能出错的事。
- **2–4 个 `pattern`** —— 你反复在做的事。
- **1–2 个 `persona` 或 `principle`** —— 声音 / 姿态。
- **1 个 `collection`** —— 把上面打包，给 `scout` 查询用。

合计约 15 atom。边：每个 `pattern` 至少 `requires` 一条 `rule`；
每个 `persona` 通过 `must-include` 至少引 3 条 `pattern`。

不漂亮，但够用。从这里长。

---

## 模式：什么时候拆 corpus

一个仓库、一个 corpus、一个 MCP server 是最简形态。下面情况才拆：

1. **受众分叉**。前端设计 corpus 和 安全 corpus 服务的是不同的
   agent，拆开各自有发布节奏。
2. **scope 撞了**。你的 `@community` 开始和别的团队的 atom 撞名。
   切出 `@community-cooking` / `@community-frontend`。
3. **版本节奏不同**。烹饪 corpus 已稳；前端 corpus 周更。两个
   corpus 让你冻一个不挡另一个。

别提前拆 —— 一个有 scope 纪律的单 corpus 比两个共享 atom 的双
corpus 容易推理多了。

---

## 模式：什么时候新开一个 namespace

namespace（`@scope`）就是 `sources/` 下的一个目录。下面情况新开：

- **作者边界**。`@core`（你出）vs `@community`（别人出）。
- **稳定边界**。`@stable`（冻结）vs `@experimental`。
- **同一 corpus 内的领域分区**。酒店 corpus 里
  `@cooking` 和 `@cocktails`。

namespace 就是一个目录。零 schema 成本。该用就用。

---

## 反模式

### 深嵌套 atom

如果你在一个 `.prime` 里写嵌套对象嵌到第三层，那是个信号：拆。
深一些的层级**多半本来就该是独立 atom**，外层 atom 引它。

### 没边的 atom

没边的 atom 除了直接 id 查询之外不可达。如果 agent 找到 X 的唯一
途径是已经知道 X 的存在，那就是死重。要么往 X 加入边（别人来
`enhance`/`require`/`relate-to` 它），要么删了。

例外：bootstrap 第一周。第二个月起，每个 atom 至少应该有一条入边
和一条出边。

### 巨型 atom

1000 行的 atom 本质是错的。整个协议的赌注就是「小 atom 懒加载」；
巨型 atom 把这个赌注拍碎。一个 `.prime` 写到约 400 行就该拆。常见
拆法：

- 一个 `pattern`，`solution:` 里写了大段 prose → 一个 `pattern`
  （问题 + 解法纲要） + N 个 `step` atom（具体流程） + 1 个
  `template` atom（示例输出）。
- 一个 `persona`，`voice:` 例子很长 → 一个 `persona` + 1 个 `voice`
  atom + N 个 `template` atom（每个对应一类 voice 例子）。

### kind 边界不一致

定一次，写下来，跟着走。一半 atom 用 `rule` 表达「可能错的事」，
另一半用 `check`，retriever 看到的是个随机区分，agent 也是。挑一种
边界、写在 CONTRIBUTING.md 或者一个 `principle` atom 里都行。

### 不跑 `prime check --registry`

完整性检查很快（100 atom 约 50 ms）。每次提交都跑。最常见的「静默
失败」就是边目标里的 typo —— `@me/rule-fooo` 而不是 `@me/rule-foo`
—— 只有 registry 检查会暴露出来。

---

## 参考：`prime-decompose` Skill

System 仓库自带的 `prime decompose` 是纯启发式 verb。**Skill 版**
（住在 corpus 仓库，**不在这里**）是 LLM 驱动，质量高得多：

```
长篇 SKILL.md  →  prime-decompose Skill  →  10–30 个落进
                                            你 corpus 的 atom
```

如果你已经有一个 markdown SKILL bundle 想转成 atom，**Skill 是推荐
路径**。CLI verb 适合做一遍粗筛；要生产质量的 decomposition，用
Skill。

Skill 跟它生产出来的 corpus 放在一起，因为它的 prompt 和示例映射
天然是领域专属的。每个 corpus 作者都可以 fork 这个 Skill，调它的
kind 检测启发式适配自己的领域。

---

## Checklist

宣布一个 corpus「ready」前：

- [ ] 至少 15 个 atom，跨至少 4 种 kind
- [ ] `prime check --registry` 完全干净
- [ ] 每个 atom 至少有一条入边或出边
- [ ] 中心 atom 上至少有一条 composition contract（`must-include` /
      `must-avoid`）
- [ ] 你能给出 3 条真实 brief，agent 仅靠索引就能找到对的 atom
- [ ] corpus 根目录有一个 README，说清楚 scope、用了哪些 kind、
      namespace 约定
- [ ] （要发布的话）目标 registry 上的 `prime publish` 回环测过

---

## 相关

- `docs/zh-CN/cli.md` —— 每个 CLI verb 详解。
- `docs/zh-CN/dsl-quickref.md` —— 28 种 kind 和它们的必填字段。
- `docs/zh-CN/mcp.md` —— 把 corpus 接进 Claude Code。
- `docs/zh-CN/registry.md` —— 自托管 registry。
- `examples/hello-world/` —— 最小 5-atom corpus。
- `examples/recipes/` —— 15-atom 跨领域示例。
- `examples/coding-style/` —— 12-atom 团队 lint corpus。
