# 为 AOE / Prime 贡献代码

[English](./CONTRIBUTING.md) · [中文](./CONTRIBUTING.zh-CN.md)

感谢你考虑为 AOE 系统做贡献。这份文档面向**扩展系统本身**的人 ——
parser、compiler、runtime、registry 或 CLI。如果你想写原子（知识内容），你找
错仓库了；请去对应的 Domain Package 仓库（比如 `aoe-frontend-design`），看那边的
CONTRIBUTING。

---

## 目录

- [什么属于这里，什么属于 corpus 仓库](#什么属于这里什么属于-corpus-仓库)
- [开发环境搭建](#开发环境搭建)
- [项目结构](#项目结构)
- [运行测试](#运行测试)
- [测试规范](#测试规范)
- [添加一个新的原子 kind](#添加一个新的原子-kind)
- [添加一个新的边动词](#添加一个新的边动词)
- [版本管理：规范 vs 实现](#版本管理规范-vs-实现)
- [依赖策略](#依赖策略)
- [Pull Request 检查清单](#pull-request-检查清单)
- [行为准则](#行为准则)

---

## 什么属于这里，什么属于 corpus 仓库

**这个仓库 —— `aoe-engine`：**
- `.prime` DSL parser（`packages/parser/`）
- 编译器 L1、L2、L3 passes（`packages/compiler/`）
- Runtime：原子加载器、投影解析器、domain plugin host（`packages/runtime/`）
- 输出校验框架（`packages/validator-core/`，v0.2 计划）
- Registry HTTP 服务（`packages/registry/`）
- `prime` CLI（`packages/cli/`）
- 通用 MCP server（`packages/mcp-server-core/`）
- 协议规范（`spec/PRIME-PROTOCOL-v1.md`）
- 示例语料库（`examples/`）
- 系统级测试

**Domain Package 仓库（例如 `aoe-frontend-design`）：**
- 原子 `.prime` 源文件
- 领域专属的意图识别器
- 领域专属的检索逻辑
- 领域专属的 MCP wrapper 工具
- 原子写作指南

如果你的改动是引入新的原子或领域专属逻辑，它属于 corpus 仓库。如果它改变了
协议 —— 原子如何被解析、编译、检索或服务 —— 它属于这里。

---

## 开发环境搭建

要求：

- **Node 22+**（用原生 TS strip：`--experimental-transform-types`）
- **Bun**（推荐，install 和 test 更快；npm 和 pnpm 也可以）

```bash
git clone https://github.com/kernary-aoe/aoe-engine.git
cd aoe-engine
bun install
bun run build
```

验证构建成功：

```bash
bun run packages/cli/src/index.ts --version
# prime 0.1.0
```

运行完整测试套件：

```bash
bun run test
```

只运行 parser 测试：

```bash
bun run test --filter packages/parser
```

对示例语料库做烟雾编译：

```bash
bun run packages/cli/src/index.ts compile examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled
```

---

## 项目结构

```
packages/
├── parser/           # .prime DSL lexer + 递归下降 parser
│   ├── src/
│   │   ├── lexer.ts          # tokenizer
│   │   ├── parser.ts         # 递归下降解析
│   │   ├── grammar.ts        # 原子 kind schema（字段要求）
│   │   └── ast.ts            # AST 节点类型
│   └── tests/
├── types/            # 共享 TypeScript 类型
│   └── src/
│       ├── atom.ts           # AtomKind、AtomRef、Atom
│       ├── edge.ts           # EdgeVerb、Edge
│       └── projection.ts     # ProjectionLevel、AtomProjection
├── compiler/         # L1 / L2 / L3 passes + 原子目录 emitter
│   ├── src/
│   │   ├── l1-checker.ts     # 结构校验
│   │   ├── l2-checker.ts     # 语义 LLM 检查（可选）
│   │   ├── l3-checker.ts     # 跨原子图检查
│   │   ├── chunker.ts        # 投影 emitter（summary/core/full）
│   │   ├── edge-resolver.ts  # 解析 @ref 目标；构建邻接表
│   │   └── emitter.ts        # 把原子目录写到输出
│   └── tests/
├── runtime/          # 原子加载器 + 投影解析器 + domain plugin host
│   └── src/
│       ├── loader.ts         # 把 compiled/*.json 加载进内存
│       ├── projection.ts     # 按需解析 summary/core/full
│       └── domain-host.ts    # 插件接口（v0.1.0 里是 stub）
├── validator-core/   # 通用 3 层输出校验框架（v0.2 计划，v0.1.0 未发布）
│   └── src/
│       ├── l1-validator.ts   # 结构检查
│       ├── l2-validator.ts   # LLM 语义检查
│       └── l3-validator.ts   # 组合契约检查
├── registry/         # HTTP 包注册表
│   └── src/
│       ├── server.ts         # Express server，publish (PUT) + install (GET)
│       └── auth.ts           # token 认证
├── cli/              # `prime` 命令
│   └── src/
│       ├── index.ts          # 入口，verb 分发
│       └── commands/         # 每个 verb 一个文件
└── mcp-server-core/  # 通用 MCP server（约 200 行）
    └── src/
        └── server.ts         # aoe_query 跑在任何编译好的语料库上
```

---

## 运行测试

| 命令 | 运行内容 |
|---|---|
| `bun run test` | 所有 package |
| `bun run test --filter packages/parser` | 仅 parser 测试 |
| `bun run test --filter packages/compiler` | 仅 compiler 测试 |
| `bun run test --filter packages/runtime` | 仅 runtime 测试 |
| `bun run test:integration` | 端到端：编译 examples + registry 回路 |
| `bun run check-registry` | Registry publish + install 烟雾测试 |

CI 在每次 push 到 `main` 以及每个 pull request 时运行以上全部。

---

## 测试规范

没有测试的贡献不会被合并。以下规则不可妥协：

**Parser 改动：**
- 每个新语法特性必须有至少一个正向测试（能正确解析）和一个负向测试（按预期
  报错）。
- 测试放在 `packages/parser/tests/`。新特性放新文件；不要追加到无关的测试文
  件里。
- Parser 测试必须是确定性的 —— 不能有外部网络调用。

**Compiler 改动：**
- 新的 L1 检查需要一个单元测试，证明该检查对违规输入触发、对合法输入通过。
- 新的 L3 检查需要一个集成测试，编译一个包含该违规的小语料库，并断言错误出
  现在编译器输出里。
- L2 改动（语义校验器）需要 mock 掉 LLM 调用 —— CI 里不能发真实 API 请求。

**Runtime 改动：**
- 对加载器、投影解析器或 domain plugin host 的改动需要一个烟雾测试：编译
  `examples/hello-world/` 并在每个投影层级（summary、core、full）至少加载一
  个原子。
- 烟雾测试放在 `packages/runtime/tests/smoke.test.ts`。

**CLI 改动：**
- 新 verb 需要一个测试，对 `examples/hello-world/` 调用该 verb，并断言退出码
  和 stdout 格式。

**Registry 改动：**
- publish + install 回路测试必须通过（`bun run check-registry`）。

---

## 添加一个新的原子 kind

添加一个一等公民的原子 kind 需要在三个地方做改动：

**1. `packages/types/src/atom.ts`**

把新 kind 加到 `AtomKind` 联合类型里。

```typescript
export type AtomKind =
  | "fact" | "rule" | "pattern" | /* ... 已有的 ... */
  | "your-new-kind";
```

**2. `packages/parser/src/grammar.ts`**

为新 kind 加 schema：哪些字段必填，哪些可选，以及它们的类型。

```typescript
export const ATOM_SCHEMAS: Record<AtomKind, AtomSchema> = {
  // ... 已有 kind ...
  "your-new-kind": {
    required: ["claim", "scope"],
    optional: ["rationale", "examples"],
  },
};
```

**3. `packages/compiler/src/chunker.ts`**

在投影 emitter 里加一个 case，决定你的 kind 的 `summary`、`core`、`full` 三
层投影各暴露哪些字段。经验规则：

- `summary`：标识原子的一两个字段（通常是 `id` + "标题"字段）。
- `core`：agent 对该原子采取行动所需的字段，不含全部细节。
- `full`：所有有语义意义的字段。

做完这三处改动后，按[测试规范](#测试规范)写 parser 测试和 compiler 集成测试，
然后开 PR。

**正式提议新 kind：** 如果你想把这个 kind 纳入规范（而不是作为 corpus 专属的
custom kind），请先开一个 discussion issue。规范独立版本化；往规范里加 kind
需要具体的使用案例、示例原子和提议的 schema。规范改动会批量合入规范小版本。

---

## 添加一个新的边动词

边动词比原子 kind 更简单，因为它和 atom schema 正交。

**1. `packages/types/src/edge.ts`**

把新动词加到 `EdgeVerb` 联合类型里。

```typescript
export type EdgeVerb =
  | "related" | "requires" | /* ... 已有的 ... */
  | "your-new-verb";
```

**2. `packages/parser/src/grammar.ts`**

把动词加到 `EDGE_VERBS` 集合里，这样 parser 就会在边声明里接受它。

**3. `packages/compiler/src/l3-checker.ts`**

决定新动词是否需要任何 L3 语义。例如：
- `requires` 触发传递闭包校验。
- `contradicts` 触发不得共存标记。
- 纯信息性动词（比如 `see-also`）不需要 L3 逻辑。

如果你的动词隐含一个约束，在这里实现并加集成测试。

**4. 规范含义：** 如果动词有超出标签的语义意义，它属于规范
（`spec/PRIME-PROTOCOL-v1.md §2`）。在同一个 PR 里记录它的语义。纯项目内部的动词
应该用 `relationships`（catch-all），直到被证明值得正式化。

---

## 版本管理：规范 vs 实现

协议规范（`spec/PRIME-PROTOCOL-v1.md`）独立于实现 package 进行版本化。

- **规范版本**（`v1.0`、`v1.1`……）：追踪哪些原子 kind、边动词和协议语义是官
  方支持的。规范在初始版本时冻结在 v1.0。对规范的改动需要一个带讨论期的规范
  PR。
- **实现版本**（`packages/*/package.json`）：追踪软件发布。实现版本独立地遵
  循 semver。

仅改变 compiler 如何 emit JSON —— 而不改变什么是合法 `.prime` 语法 —— 只升
级实现版本。添加新的原子 kind 或边动词到语法里，升级规范版本。

编译器的构建输出包含 `[spec: vX]` 标签，让语料库作者知道编译器实现了哪个规
范版本。

---

## 依赖策略

AOE 系统刻意保持精简。添加新的 runtime 依赖需要说明理由。

**规则：**

1. **没有无理由注释的新 runtime 依赖。** "方便"不是理由。"它替代了否则需要
   维护的 200 行代码"是理由。

2. **需要原生编译的新依赖**（二进制文件、`.node` 文件、WASM blob）在没有
   discussion issue 的情况下不得引入。这些会破坏"能在任何跑 Node 22 的地方
   安装"的保证。

3. **开发依赖约束更少**，但仍应审查。优先使用项目中已有的工具（Bun test
   runner、TypeScript 等），不要引入新的测试框架。

4. **Vendor 策略。** 如果一个依赖很小（< 200 行）且稳定，考虑把它复制到
   `packages/<pkg>/vendor/` 并保留 license header，而不是依赖 registry。

---

## Pull Request 检查清单

开 PR 前确认：

- [ ] 所有现有测试通过（`bun run test`）。
- [ ] 改动包含了新的测试（见[测试规范](#测试规范)）。
- [ ] `bun run build` 成功，没有 TypeScript 错误。
- [ ] `bun run test:integration` 通过（编译 examples + registry 回路）。
- [ ] 如果是新原子 kind：`packages/types/`、`packages/parser/grammar.ts` 和
      `packages/compiler/chunker.ts` 都已更新。
- [ ] 如果是新边动词：`packages/types/`、`packages/parser/grammar.ts` 和
      `packages/compiler/l3-checker.ts` 都已检查。
- [ ] 如果是规范层面的改动：`spec/PRIME-PROTOCOL-v1.md` 在同一个 PR 里更新。
- [ ] 没有无理由注释的新 runtime 依赖。
- [ ] PR 描述解释了改动**为什么**需要，而不仅仅是**做了什么**。
- [ ] PR 标题遵循项目约定：`feat(scope): 描述`、`fix(scope): 描述` 等。

---

## 行为准则

本项目遵循 [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md)。请以善意参与。
任何形式的骚扰都不被容忍。

---

*AOE v0.1.0 · Apache-2.0*
