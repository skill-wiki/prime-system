# 路线图

> Skill Wiki / Prime 接下来要去哪。每条都标了状态和理由。
> 已经做完的看 [CHANGELOG.zh-CN.md](../../../CHANGELOG.zh-CN.md)。

这份路线图只覆盖 **system** 仓库。Corpus 仓库（比如
`prime-corpus-frontend`）有自己的路线图；协议自己的节奏，不绑死任何一个
具体 corpus。

状态图例：

- ✅ **已发布** —— v0.1.0 已含
- 🟡 **进行中** —— 在做
- 🔵 **已计划** —— 已承诺，未开工
- ⚪ **观望中** —— 还在权衡
- ❌ **不打算做** —— 明确不收

---

## v0.1.0 — 协议地基 `[已发布 2026-05-09]`

协议地基：与具体 corpus 解耦的协议实现。

✅ Parser + L1 结构校验
✅ L3 跨原子图校验
✅ Runtime 原子加载 + 投影解析
🔵 通用 validator-core（L1/L2/L3 框架，HTML 无关）—— v0.1.0 未发布
✅ HTTP registry（publish / install）
✅ `prime` CLI，10 个 verb
✅ 通用 MCP server（`prime_query` 跑在任何编译好的 corpus 上）
✅ 3 个示例 corpus 证明跨领域适用
✅ 协议规范：`spec/PRIME-PROTOCOL-v1.md`
✅ Apache-2.0 + NOTICE

---

## v0.2 — Lifecycle 与 AST `[计划 · 2026 Q3]`

v1 spec 里写过、但 v0.1 没真正落地的两块。

### 🔵 Lifecycle 强制

DSL 允许 `version: "1.2.0"` 和状态字段：
`active` | `deprecated` | `experimental`。今天 parser 接受这些字段，
但 compiler 啥都没干 —— `deprecated` 原子照样进检索结果，没有警告。

计划：当 `prime_query` 选中一个 `deprecated` 原子时，响应里带
`warnings: [{ kind: "deprecated", atom_id, message, replacement }]`。
Runtime API 透出来，CLI 打一行黄字。

可选追加：`prime check --strict-deprecation` 在 corpus 里有"指向 deprecated
原子的活引用"时让构建失败（比如 `requires:` 边指过去）。
软弃用 → 硬弃用的流水线就有了。

### 🔵 结构化的类型 AST

原子可以声明类型，用一个小表达式语言：
函数签名 `(input: AtomList) -> CompositionResult`、
联合 `"low" | "med" | "high"`、范围 `0.0-1.0`。
今天 parser 把这些当字符串 round-trip，原样进原样出 ——
正确，但 compiler 没法对它们推理。

计划：建 `TypeExpr` AST（Function | Union | Range | Primitive | Ref）。
用它强制比如 `fact` 原子的 `confidence:` 解析为 `0.0-1.0` range。
为更好的错误信息和未来的"组合类型检查器"打底。

---

## v0.3 — 正式的 domain plugin 协议 `[计划 · 2026 Q4]`

今天 `domain:` 是每个原子的元数据 tag。Runtime 对 `frontend-design`、
`security`、`recipes` 一视同仁 —— 检索调用拿到啥就返啥，不管 brief
是讲 HTML 还是讲沙拉酱。

实践中能跑下去是因为每个 MCP server 通常只挂一个 corpus。
但 spec 里早就预想"多 corpus 共存于一个 server，按 domain 路由"。
要走到那一步：

### 🔵 Plugin 接口

```typescript
interface DomainPlugin {
  name: string;                                    // "frontend-design"
  matches(intent: IntentObject): number;            // 0-1 分
  retrievalAxes: AxisDefinition[];                  // domain 专属轴
  validators: { l1?, l2?, l3? };                    // domain 专属校验器
}
```

Corpus 包注册插件，runtime 把 brief 路由到分数最高的插件，套用
那个插件的检索轴和校验器。

### 🔵 多 corpus MCP

MCP server 通过多个环境变量或配置文件支持多个 corpus。通用的 `prime_query`
工具新增可选参数 `corpus:`。不传时按意图推断。

### ⚪ Domain 自动消歧

当 brief 在两个 corpus 之间模糊（比如"为食谱步骤做一个布局" ——
recipes? frontend-design?）时，runtime 返回每个 corpus 的候选原子列表，
按各自的 rank 排，让 agent 选。

---

## v0.4 — 更好的 registry `[计划 · 2027]`

v0.1 的 registry 是裸 HTTP 服务：PUT 发布，GET 安装。没 semver 解析、
没签名、没审计。够团队自托管，但不足以做"agent 知识的 npm / crates.io"。

🔵 Semver 安装。`prime install @example/atom@^1.2` 解析到最高匹配版本，
   `prime.lock` 锁定。
🔵 加密签名。作者签原子，消费者验证。
🔵 审计日志。Registry 记录谁发了啥，何时发的。第三方命名空间要可信
   就需要这个。
⚪ Web UI。浏览器里看原子 / collection。除非真有人自托管公开 registry，
   不然不做。

---

## Prime 自演化 `[计划 · 2026 → 2027]`

为什么：只靠人工 PR 添加原子的 corpus 会变陈旧。真实使用本身就是最好的
信号 —— 哪些原子被查了但没命中、哪些意图返回的置信度低、哪些 projection
被 agent 在使用前重写。v0.1 把这些信号全扔了。v0.2+ 留下来，opt-in，
反哺 corpus。

### 🔵 Telemetry ingest API

一个小的 opt-in HTTP 端点。Runtime 在每次 `prime_query` 后 POST：
intent、查的 kinds、返回的 ids、projection 层级、命中 / 未命中、延迟。
不带正文，不带 PII。默认关闭，按 corpus 在 `domain.yaml` 里开启。

### 🔵 Atom 提案 PR-bot

定时任务读 telemetry 流，找出反复零命中的查询，用 LLM 抽取器（DSPy 风格
的 program）提出新原子。产出：一份给 corpus 仓库的 draft PR，里面是占位
`.prime` 文件，由 maintainer 编辑后合入。

### 🔵 边推断反思 pass

corpus 作者写完原子后，跑一个 TextGrad 风格的 pass：对每对原子做反思，
提出可能的边（`requires`、`contradicts`、`validates-with`）。
Maintainer 决定收 / 不收，不自动合并。

### ⚪ Marketplace UI 中的原子 diff 视图

当 corpus 版本上跳时，按原子粒度展示 diff：哪些原子改了、哪些边动了、
哪些 projection 重渲染了。让消费者审计升级。

### ⚪ Projection prior 自动调参

chunker 的 projection prior（哪些字段进 `summary`、哪些进 `core`、哪些
进 `full`）今天是按 kind 手写的。可以用 DSPy 风格的 program 按 corpus
调，目标函数是下游任务正确率。

**Moonshot：** schema 演化。今天原子 kind 由 spec 锁定。攒了足够 telemetry
的 corpus 可以*提议自己的 kind* —— 类似
[AutoSchemaKG](https://arxiv.org/abs/2402.14531) —— 再冒泡到 v2 spec
作候选。

参考：
[DSPy](https://dspy.ai/) ·
[TextGrad](https://textgrad.com/)

---

## Prime 评测 `[计划 · 2026 Q4]`

协议有用，前提是可量化。今天唯一的评测是"agent 引用对了几个原子" ——
人工跑 20 题基准。v0.2 把它升级成一等动词。

### 🔵 `prime eval` CLI 动词

corpus 作用域的评测 harness，底层包
[Inspect AI](https://inspect.aisi.org.uk/)。读一个 `eval/` 目录里的
任务定义，对配好的 agent 跑，按预期原子引用和领域专属打分器评分。

### 🔵 MCP-Bench 适配器

把 Skill Wiki corpus 暴露给
[MCP-Bench](https://github.com/Accenture/mcp-bench)，让 corpus 在同一套
任务上和别的 MCP server 直接对比。

### 🔵 领域专属打分器插件

Harness 自带 kind-aware 打分器，corpus 可以再注册。
`prime-corpus-frontend` 的例子：axe-core 通过率、Lighthouse 分、
视觉回归 delta。安全 corpus 的例子：OWASP 规则通过率。

### ⚪ 三臂 A/B harness

`prime eval --arms prime,skill,raw` 同一题跑三遍 —— 一遍挂 Skill Wiki
corpus、一遍批量 SKILL.md、一遍裸跑 —— 报告 delta。让 corpus 作者
能拿出协议值不值这个钱的证据。

### ⚪ 引用精度指标

`prime_query` 返回的原子里，有多少出现在 agent 最终输出里？精度高的
corpus = 检索校准得好；精度低的 corpus = 过取或漏用。

**Moonshot：** 公共 Prime 排行榜。corpus 注册进来，harness 每周跑一套
固定任务，发布带版本锁定的结果。和代码界的
[HumanEval](https://github.com/openai/human-eval) 一个意思。

参考：
[MCP-Bench](https://arxiv.org/abs/2508.20453) ·
[Inspect AI](https://inspect.aisi.org.uk/)

---

## Prime 优化 `[计划 · 2027]`

v0.1 检索路径很朴素：加载 `_index.xml`、排序、取 projection。1k 原子
没问题，10k 就浪费，100k 装不下 context。v0.3+ 把这条路收紧。

### 🔵 按意图剪枝边图

查询时从种子原子按 `max_depth` 走边图，*但*剪掉动词组合与意图不匹配
的分支（比如 "实现" 意图，丢掉 `tradeoff`、`provocation` 边）。
候选集变小，相关 kind 的 recall 不变。

### 🔵 Projection 压缩器（`--compress` 标志）

LLMLingua 风格的压缩器，在 serve 时按需对 `core` 和 `full` projection
压一遍。略损保真度，换约 2× token 节省。

### 🔵 原子结果缓存

按 `(intent_hash, kinds, max_atoms)` 内容寻址。同一 session 里同样的
查询零检索成本。corpus 重编译时失效。

### ⚪ 多 Prime 组合预算

挂多个 corpus（v0.3 多 corpus MCP）时，runtime 按各 corpus 的意图分
分配 token 预算，不再用固定配额。

### ⚪ 编译期意图 projection profile

把 corpus 编译 *N* 次，每个意图类（"design"、"implementation"、
"review" 等）一次，产出强调不同字段的 per-class `core` projection。
Runtime 按意图选 profile。

**Moonshot：** 每个原子一份
[KVzip](https://arxiv.org/abs/2505.23416) 风格的 key-value 记忆。
编译期缓存 `core` projection 的 decoder KV state；检索时拼接进去，不再
重编码。每轮的重编码成本被消掉。

参考：
[LLMLingua](https://github.com/microsoft/LLMLingua) ·
[KVzip](https://arxiv.org/abs/2505.23416)

---

## v0.2 五个核心交付

如果 v0.2 只能发这五件东西，整个版本就靠它们撑：

1. **`prime eval` CLI** —— 让所有别的主张可量化的 harness。
2. **Telemetry ingest + 原子提案 bot** —— 关掉 corpus 陈旧化的回路。
3. **原子 diff 视图** —— 用户信任 corpus 版本上跳的前提。
4. **按意图剪枝边图** —— 第一项第一天就回本的检索优化。
5. **引用精度指标** —— 一个数字告诉作者：你的原子有没有干活。

---

## v1.0 spec → v2.0 spec `[观望 · 2027]`

当前 spec 冻结在 28 种原子 kind、14 种边动词、5 个 MCP 工具
（在 wrapper 层；system core 只有 1 个）。
v2 的开放问题：

### ⚪ kind 是不是该更少？

实践中有些 kind 几乎没用。`provocation`、`feedback`、`tradeoff` 可以
合并成 `principle` 加一个 `subtype:` 字段，顶层 kind 数从 28 降到 22。
反对意见：kind 名字本身就是检索的语义提示，合并会糊掉 ranking。
等再有 3-5 个 corpus 仓库出现后再回头看。

### ⚪ 边动词要不要可扩展？

今天 14 个动词是闭集。一个 corpus 想要 `regulates`（比如某 ISO 标准
原子 regulates 一条 `rule`）就只能凑 `validates-with` 或 `enhances`。
加一个 `verb_extensions:` 声明，让 corpus 注册带语义文档的新动词。
风险：每个 corpus 都搞自己方言，检索可移植性玩完。
缓解：spec 列出哪些是核心动词、哪些是扩展；工具默认对扩展动词警告。

### ⚪ 原子要不要内容寻址？

原子现在有字符串 `id`。已发布原子改了内容，下游静默改变行为。
内容寻址（每个原子编译后 JSON 哈希；引用带哈希）能抓住这个；
还能让分布式 registry 成立（任何人 host 任何 hash）。
权衡：人类可读的 id 写起来舒服；hash 长得难看。
可能的折中：保留人类 id，加一个 `@digest` 后缀做可选锁定。

---

## 不在范围内（这里不做）

❌ **以向量 embedding 为主的检索**。协议是结构化检索。embedding 可以叠在
   上面（corpus 编译时算 embedding，retrieval 插件用它），但不是底子。

❌ **浏览原子的网页应用**。那是 corpus 仓库的事，不是协议的事。

❌ **"Skill 编译器"，把 SKILL.md 转成原子**。在 corpus 仓库里，作为
   `prime-decompose` Claude Code Skill 存在 —— 它是领域邻接的（你拆到
   *某个* corpus），不该是 system 的责任。

❌ **Corpus 的打包 / 压缩传输**。Corpus 编译产物已经够小了（每个原子
   一个目录，每个 level 一个 projection）。要更小，gzip 一下。

❌ **内置可观测 / 指标**。MCP server 写 stderr。要 Prometheus /
   OpenTelemetry，包一层就行；协议不需要知道。

---

## 优先级怎么定

任何新增项要权衡三件事：

1. **能不能解锁一个 *现存* corpus 团队的卡点？**（强 yes。）
2. **是否在多个 corpus 间通用？**（强 yes —— 协议层的特性必须通用。）
3. **是否保留"小内核 + 表达力强的 corpus"的平衡？**
   System 仓库目标 < 15k LoC。任何膨胀协议实现的事都得证明值。

要加 feature 最快的路径是：
（a）先在某个 corpus 仓库里原型化，
（b）移植到第二个 corpus 证明它通用，
（c）再回来提议把它进协议。

---

## 跟踪

正在做的：GitHub Project board（仓库公开后挂链接）。
重大决策落到本文件；细节微调进 CHANGELOG。
