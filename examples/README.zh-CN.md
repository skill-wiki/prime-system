# 示例语料库

> 三个最小、完整、跨领域的语料库。从 Hello World 到真实但精简。

三个可运行的语料库，分属物理、烹饪和团队工程标准三个领域。
每个都是完整的语料库：两分钟内可以编译、启动 MCP server、开始查询。

选择与你的起点最匹配的那个。

---

## 三个语料库

| 语料库 | 原子数 | 使用的种类 | 教会你什么 |
|---|---|---|---|
| [`hello-world/`](./hello-world/) | 5 | fact, term, rule, method, collection | 冒烟测试。一条命令编译，一条命令查询。验证你的安装是否正常。 |
| [`recipes/`](./recipes/) | 15 | fact, term, rule, pattern, anti-pattern, method | 跨领域证明。展示图的密度、类型化边以及不同知识种类之间的互动。 |
| [`coding-style/`](./coding-style/) | 12 | rule, pattern, anti-pattern, principle, tradeoff, collection | 机构知识。将团队的 lint 规则变成原子——用 `tradeoff` 种类展示明确的工程张力。 |

---

## 如何选择

**我想验证安装是否正常。**
→ [`hello-world/`](./hello-world/)。5 个原子，1 条编译命令，完成。

**我在创作第一个真实语料库，需要一个可以参考的模式。**
→ [`recipes/`](./recipes/)。15 个原子涵盖 8 种类型。密度足以看清图是如何形成的，小到 20 分钟可以读完。

**我想将团队的工程规范编码给 AI 助手使用。**
→ [`coding-style/`](./coding-style/)。12 个原子展示规则、模式、反模式、原则和权衡。
直接用作模板：复制，将 `@team` 改为你的命名空间，根据实际规则调整原子。

**我想看协议能表达的全部特性范围。**
→ 按顺序阅读全部三个语料库，每个渐进式地展示更多协议特性。

---

## 每个语料库展示什么

### hello-world — 冒烟测试（5 个原子）

展示：fact / term / rule / method / collection — 最常用的五种类型。
展示：`requires`、`supplies-to`、`enhances`、`includes` 边动词。
不展示：pattern、anti-pattern、tradeoff，或深度图遍历。

### recipes — 跨领域证明（15 个原子）

8 种类型，30+ 条边。一个 method（`method-pan-sauce`）要求跨三种类型的 4 个原子。
反模式通过 `see-also` 互相指向。一个 pattern 通过 `supplies-to` 提供给一个 method。

展示：图的密度、跨种类边、`anti-pattern` 和 `pattern` 种类，
以及语料库如何自然地围绕枢纽原子形成图。

### coding-style — 机构知识（12 个原子）

TypeScript 团队的风格指南。4 条强制规则，3 种推荐模式，
2 个主动反模式，1 个根原则，1 个明确权衡，1 个合集。

展示：`principle` 种类（根启发）、`tradeoff` 种类（明确的工程张力），
以及原子如何与 linter 共存
（`rule` 原子解释*为什么*，`.eslintrc` 强制执行*如何*）。

---

## 语料库与系统的关系

每个语料库都是独立的。它存在于自己的目录中，有自己的 `primes/sources/`
和 `primes/compiled/`。系统仓库提供工具；语料库提供知识。

```
aoe-engine/        ← 此仓库（工具、parser、compiler、runtime）
  examples/
    hello-world/       ← 精简语料库，随此仓库发布，用于冒烟测试
    recipes/           ← 中型语料库，随此仓库发布，跨领域证明
    coding-style/      ← 中型语料库，随此仓库发布，机构知识证明
  packages/
    parser/
    compiler/
    ...

aoe-frontend-design/ ← 独立 Domain Package
your-corpus/           ← 你的领域、你的命名空间、你的原子
```

通用 MCP 服务器（`packages/mcp-server-core/`）适用于任何编译后的语料库。
将它指向以上任一目录，它就会通过 MCP 协议提供该语料库。

---

## 创作你自己的语料库

阅读完这些示例后，参考创作指南：

- [`docs/corpus-authoring.md`](../docs/corpus-authoring.md) — 从这里开始
- [`docs/dsl-quickref.md`](../docs/dsl-quickref.md) — 逐字段 DSL 参考
- [`spec/PRIME-PROTOCOL-v1.md §1.2`](../spec/PRIME-PROTOCOL-v1.md) — 全部 28 种原子类型及必填字段

简短流程：
1. `aoe init my-corpus/` — 初始化目录
2. 在 `my-corpus/primes/sources/@myscope/` 中编写 `.prime` 文件
3. `aoe compile my-corpus/primes/sources --out my-corpus/primes/compiled`
4. `AOE_CORPUS_DIR=my-corpus/primes/compiled bunx @aoe/mcp-server-core`
5. 将 MCP 服务器接入你的 Agent

本地使用语料库不需要发布到注册中心。
发布是可选的——用于与团队或社区共享。
