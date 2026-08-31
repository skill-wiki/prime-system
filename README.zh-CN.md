# Prime System

Prime System 是领域无关的知识引擎协议、编译器、运行时与 SDK。

它不内置生产本体和真实语料。类型、字段、关系、投影、检索策略、
Action 与 Validator 由外部 Model Package 声明；数据单元和资产由外部
Corpus Package 提供。

```text
Model Package + Corpus Package + Adapters
                    │
                    ▼
 parser → IR → compiler → immutable bundle
                    │
       query · constraint · action runtime
                    │
          MCP · HTTP · SDK · CLI
```

## 安装与验证

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

## 示例编译

`compat/prime-v1-model` 只是历史 v1 模型的兼容 fixture，不是 Core Schema。

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

```bash
PRIME_DIR=examples/hello-world/primes/compiled \
PRIME_MODEL_DIR=compat/prime-v1-model \
bun packages/mcp-server-core/src/index.ts
```

## Schema 边界

引擎固定的是 `TypeDefinitionSchema`、`RelationDefinitionSchema` 等声明
元协议，不枚举领域类型或关系。只要外部模型声明，下列新类型无需修改
Parser/Compiler/Runtime：

```prime
unit INC_42 : Ticket { title: "Database unavailable" }
Widget DashboardCard { title: "Revenue" }
```

历史 28 kinds / 14 relations 仅存在于 `compat/prime-v1-model`。新领域应拥有
自己的 Model Package，而不是修改兼容 fixture。

## 核心不变量

- Runtime 只加载编译 Bundle，请求期不编译源文件。
- 启动时严格核对 Model lock 与 Bundle digest。
- Bundle、index、manifest、lock 都由工具原子生成，禁止手改。
- Selection 不自动获得 Action 权限。
- 外部写入必须经过 Action、Policy、Preflight、Idempotency 与 Event evidence。
- 领域包可以依赖 Prime System；Prime System 不得反向依赖任何领域包。

协议与架构说明见 `spec/`、`docs/`。
