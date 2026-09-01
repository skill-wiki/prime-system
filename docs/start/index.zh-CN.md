# 定义并运行一个领域本体

Kernary 把外部 Model Package 与 Corpus Package 编译成带本体语义的不可变 Runtime
Snapshot。已有 Agent 或应用可以通过 Embedded SDK、MCP 或 HTTP 使用它，不需要把
整份语料塞进 Prompt。

先选你正在做的事情：

- 已经有维护中的 Domain Package：从 **连接 Agent** 开始。
- 需要新的类型、关系、投影、检索或 Action：从 **定义领域模型** 开始。
- 模型已经存在，你负责语料来源与发布策略：从 **发布知识** 开始。
- 需要锁定版本、签名、激活、迁移、观测或 Event replay：从 **运维** 开始。

## 构建会得到什么

一个 Release 包含编译后的 Unit artifact、模型定义的 Projection、
`_index.xml`、`corpus.manifest.json` 和 `model.lock`。Runtime 会在服务前验证
Bundle identity 与内容；它不会在请求路径临时编译源文件。

```text
model/ + corpus/sources/
          │
          ▼
      compile + check
          │
          ▼
  immutable snapshot
     │           │
 query plan   action plan
```

当前维护示例使用 v1 兼容模型：

```bash
bun scripts/build-atom-dirs.ts \
  --src examples/hello-world/primes/sources \
  --out examples/hello-world/primes/compiled \
  --model compat/prime-v1-model \
  --corpus org.example/hello-world \
  --release 2026-08-31
```

成功后，已验证 Bundle 位于 `examples/hello-world/primes/compiled`。命令显式
传入模型路径，是为了避免把该示例的 Atom vocabulary 误写成 Core 规则。

下一步可以阅读 [Package 模型](../concepts/package-model.zh-CN.md)，或在已有
Bundle 时直接阅读[连接 Agent](../guides/connect-agent.zh-CN.md)。
