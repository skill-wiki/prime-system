# 入门

> 30 秒跑 hello-world。5 分钟跑完整闭环。10 分钟接进 Claude Code。
> 这一篇带你从 `git clone` 一路走到 agent 能查询的类型化 corpus。

[← 返回 README](../../README.zh-CN.md) · [架构](./concept/architecture.md) · [设计哲学](./concept/philosophy.md) · [DSL 速查](./reference/dsl-quickref.md)

---

## 前置条件

| 条件 | 为什么 |
|---|---|
| **Node 22+** | 用原生 TS strip 标志 `--experimental-transform-types`。**不需要转译步骤**。 |
| **git** | 拉代码。 |
| **Bun**（可选） | 装包 + 运行更快。`npm` / `pnpm` 也都能跑。 |
| **Claude Code MCP 支持**（可选） | 接进 agent 那一步要用。只玩 CLI 可以跳过。 |
| **DEEPSEEK_API_KEY**（可选） | 启用编译时 L2 语义校验（约 $0.0001/原子）。没设也能跑。 |

确认 Node：

```bash
node --version
# v22.x.x 或更高
```

20 / 18 跑会报 `Unknown option: --experimental-transform-types`。升级。

---

## 30 秒 hello-world

仓库带了 3 个示例 corpus。最小的是 `examples/hello-world/`，5 个原子，
讲烧水泡茶。

```bash
git clone https://github.com/skill-wiki/prime-system.git
cd prime-system
bun install        # 或 npm/pnpm install
bun run build      # 编译全部 7 个 package
```

编译 hello-world：

```bash
cd examples/hello-world
bun ../../scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled
# [build] 5 atoms compiled
# [build] L1 checks: PASS
# [build] L3 checks: PASS · 0 cycles · 0 contradictions
# [build] emitted 5 atom dirs to primes/compiled
# done in ~80ms
```

刚才发生了什么：
- Parser 读了 5 个 `.prime` 文件
- L1 校验器确认每个 atom 按 kind 把必填字段填齐
- Edge resolver 把 7 条交叉引用接好，确认所有目标存在
- Chunker 给每个原子产出 `summary.md`、`core.md`、`full.md`
- Atom-dir emitter 给每个原子建一个目录，再加一份全局 `_index.xml`

看看里面：

```bash
prime list
# @example/fact-water-boils-at-100c    fact     "纯水在 1 atm 下 100°C 沸腾。"
# @example/term-celsius                term     "摄氏温标。"
# @example/rule-altitude-affects-boiling rule  "海拔每升 150m，沸点下降约 0.5°C。"
# @example/method-make-tea             method   "水加热到 100°C，浸泡 3-5 分钟。"
# @example/collection-tea-basics       collection "把上面 4 个原子打包。"
```

查看一个原子的引用关系：

```bash
prime show @example/method-make-tea
# id:      @example/method-make-tea
# kind:    method
# version: 1.0.0
# ...related refs listed below...
```

查看一个源文件的边图：

```bash
prime graph primes/sources/@example/method-make-tea.prime
# ┌──────────────────────┐
# │  method-make-tea     │
# ├── REQUIRES ──→ fact-water-boils-at-100c
# ├── REQUIRES ──→ term-celsius
# └── ENHANCES - -→ rule-altitude-affects-boiling
```

不接 agent 的话，整个反馈循环到这里就闭合了：写原子、编译、看。

---

## 5 分钟完整闭环（接 agent）

启动通用 MCP server：

```bash
PRIME_DIR=primes/compiled bun ../../packages/mcp-server-core/src/index.ts
# [prime-mcp-core] Loading corpus index...
# [prime-mcp-core] 5 atoms · 712 tokens · 1 clusters
# [prime-mcp-core] domains: 0 (no domain.yaml found — plain ranking active)
# [prime-mcp-core] ready · tool: prime_query · stdio transport active
```

Server 在 stdio 上讲 Model Context Protocol。任何 MCP 客户端都能调
`prime_query` 工具。没有独立的 CLI 查询命令，查询走 MCP 工具接口。

---

## 接进 Claude Code

加进 `.claude/config.json`（或任何你配 MCP 的位置）：

```json
{
  "mcpServers": {
    "skill-wiki": {
      "command": "bunx",
      "args": ["@prime-lang/mcp-server-core"],
      "env": { "PRIME_DIR": "/abs/path/to/your/compiled" }
    }
  }
}
```

重启 agent。`prime_query` 这个工具会出现在 agent 的工具列表里。会话里
就能用：

> *用 prime_query 找泡茶相关的原子，然后写一份 recipe。*

Agent 调 `prime_query("泡茶")`，拿到原子 ID 和层级，对 chunk 路径调
`Read`，从这些类型化输入合成 recipe。

接上之后 agent 的 prompt 会**肉眼变紧** —— 不再凭记忆猜具体字段值；
它直接读相关原子的 `chunks/full.md` 并引用字段内容。

---

## 跑更大的 corpus

hello-world 跑通后，两条路：

### A 路 —— 拉前端设计 corpus

899 原子的前端设计 corpus 在另一个仓库。

```bash
git clone https://github.com/skill-wiki/prime-corpus-frontend.git
cd prime-corpus-frontend
bun install
bun run build           # 编译 899 原子
PRIME_DIR=compiled bun ../prime-system/packages/mcp-server-core/src/index.ts
```

这个 corpus 有自己的 MCP wrapper（5 个工具，不是 1 个；带意图分类
+ 6 轴检索）。完整接入指南看
[corpus 仓库的 README](https://github.com/skill-wiki/prime-corpus-frontend)。

### B 路 —— 写你自己的

5 个原子的团队 coding-style corpus 大约 30 分钟能写完。教程见
[corpus-authoring.md](./guides/corpus-authoring.md)，语法见
[DSL 速查](./reference/dsl-quickref.md)。

典型的第一个 corpus：

```
my-corpus/
├── primes/sources/@my/
│   ├── rule-no-any-types.prime
│   ├── rule-imports-sorted.prime
│   ├── rule-tests-required.prime
│   ├── pattern-react-component.prime
│   └── method-pull-request.prime
└── package.json
```

然后 `bun scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled` 就跑起来了。

---

## 常见踩坑

| 现象 | 原因 | 怎么解 |
|---|---|---|
| `Unknown option: --experimental-transform-types` | Node 版本太老 | 升 Node 22+ |
| `Cannot find module '@prime-lang/types'` | Package 没编 | 仓库根跑 `bun run build` |
| `parse error: unexpected token at line 12` | `.prime` 文件语法错 | 跑 `prime check <file>`，会指出精确位置 |
| `unresolved reference: @example/foo` | Atom ID 写错 / 原子不在 corpus 里 | 看目标原子的 `id:` 字段；确认文件在 sources 目录 |
| `[L3] cycle detected: A → B → A` | 两个原子互相 `requires` | 选一个方向；另一个改 `enhances` |
| `[L3] contradicts edge between active atoms` | 两个原子语义对立但都是 active | 把其中一个标 `deprecated`；如果是有意的对立，把 contradicts 边删掉 |
| Persona 的 `chunks/full.md` 是空的 | Chunker 不认识自定义字段 | 已知限制，详见 [roadmap](./community/roadmap.md)。把字段名加进 chunker include-list。 |
| `prime_query` 啥也不返回 | 索引没装 / `--corpus` 路径不对 | 确认那个路径下有 `_index.xml` |
| MCP server 起来了但 agent 看不到工具 | MCP transport 不对 / agent config 没注册 | 看 agent 的 MCP server 日志找连接错误 |
| L2 语义校验慢 | 每个原子一次 LLM call | 设 `PRIME_L2_BATCH=true` 走 batch（快得多）；不设 `DEEPSEEK_API_KEY` 直接跳过 |

---

## 第二天的诊断工具

```bash
# 只校验一个 .prime — 写原子时反馈最快
prime check path/to/atom.prime

# 查看这个原子的引用关系
prime show @scope/atom-id
prime show @scope/atom-id --json    # 机器可读格式

# 查看一个源文件声明了哪些边
prime graph path/to/atom.prime

# 加载这个原子，传递依赖闭包是什么？
prime deps @scope/atom-id

# 重新编译整个 sources 目录
bun scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled

# 详细日志，方便排查
bun scripts/build-atom-dirs.ts --src primes/sources --out primes/compiled --verbose
```

---

## 再往后看哪里

| 想…… | 看 |
|---|---|
| 理解设计 | [architecture.md](./concept/architecture.md) |
| 理解 *为什么* | [philosophy.md](./concept/philosophy.md) |
| 写原子 | [dsl-quickref.md](./reference/dsl-quickref.md) + [corpus-authoring.md](./guides/corpus-authoring.md) |
| 用 CLI | [cli.zh-CN.md](./reference/cli.md) |
| 配 MCP server | [mcp.zh-CN.md](./guides/mcp.md) |
| 发布 corpus | [registry.zh-CN.md](./reference/registry.md) |
| 跟 RAG / Skill 对比 | [comparison.zh-CN.md](./concept/comparison.md) |
| 读协议 spec | [PRIME-PROTOCOL-v1.md](../../spec/PRIME-PROTOCOL-v1.md)（仅英文） |

---

## 关于你看到的这一段

30 秒那个 loop 就是**整个系统的缩影**：

1. **写** —— 5 个 `.prime` 文件，纯文本，进 git
2. **编译** —— parser + L1 + L3 + chunker + emitter
3. **运行时** —— 装索引，走图
4. **查询** —— 按 ID 取，按层级投影

每个 Skill Wiki corpus，不管多大，跑的都是这一套。899 原子的前端
corpus 跟 5 原子的 hello-world，**只差在体量** —— 同一个 parser、同一个
compiler、同一个 runtime。

这篇里描述的步骤如果跟实际不符，请提 bug。**文档先错，代码后错**。
