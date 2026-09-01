# Release 与 Migration

AOE Release 会改变不可变 Package 或 Snapshot identity。Publish、Activate、
Migrate 与 Rollback 是不同操作。

## 构建与验证

固定 Model Package、Corpus declaration、Source inventory、Release date 与签名
Policy。先构建到 staging，验证 Manifest 和 Model lock，再原子移动到 Release
目录。

Frontend Design 参考包使用：

```bash
bun run model:check
bun run corpus:build
bun run corpus:check
bun run corpus:verify
bun run smoke
```

## 激活与回滚

激活时让 Runtime instance 指向一个已验证的不可变目录，不要覆盖正在运行的
Release。保留上一 Snapshot 的地址，使 Rollback 只是 Binding 变化，而不是反向
修改生成物。

## 迁移 Model

Migration 属于 Model Package，并声明源与目标模型版本。先在 Source 或迁移
Workspace 上执行，构建新 Snapshot，比较 Inventory 与 Identity，再激活。
