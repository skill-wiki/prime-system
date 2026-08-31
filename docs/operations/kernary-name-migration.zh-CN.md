# Kernary 外部名称迁移

代码和文档已经使用 Kernary。GitHub、npm、Registry 与域名只有在每项外部迁移
完成并验证后才切换。

| 当前 | 目标 |
|---|---|
| `skill-wiki/prime-system` | `kernary/kernary-engine` |
| `skill-wiki/prime-corpus-frontend` | `kernary/kernary-frontend-design` |
| `skill-wiki/skill-wiki.github.io` | `kernary/kernary-docs` 加自定义文档域名 |
| 外层 `prime` Workspace | `kernary-workspace` 集成仓 |
| `@skill-wiki/*` | `@kernary/*`，保留兼容发布窗口 |
| `prime` CLI | `kernary`，旧 Alias 保留一个 Minor line |

先保留组织、npm scope、Package name 与域名，再依次迁移 Engine、Domain 与 Docs
Remote，验证 GitHub redirect、Clone、Issue、Release、Pages 与 Actions。目标路径
Fresh-clone CI 通过后，才更新 Submodule URL 和本地目录。

真实发布 `@kernary/*` 后，旧 `@skill-wiki/*` 只作为薄兼容 Package，并明确标记
替代项与结束日期。`.prime`、`prime/*` Protocol ID、环境变量和序列化 Corpus
identity 保持稳定，直到存在版本化 Protocol Migration。

最后从没有旧 Checkout 或 Package cache 的机器执行 Install、Compile、Query、
Action、Registry round-trip 与 Rollback。目标 Owner 不可用、公开 Package 无法安装、
Submodule Redirect 断裂或 Canonical 指向未服务 Host 时必须停止，不得靠改写 Bundle
identity 掩盖迁移失败。
