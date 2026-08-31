# HTTP 与 Registry

HTTP Server 把 Snapshot、Plan、Query 与 Resource 操作委托给 SDK 使用的同一
Engine Transport。它只增加网络边界问题，不增加领域语义。

## HTTP 安全 Contract

- 除 `/healthz` 外的 Route 都需要 Bearer credential。
- Server 从 Credential 推导 Principal；Request body 不能选择自己的 Principal。
- 默认只绑定 Loopback；暴露到非 Loopback 地址需要显式确认。
- 远程部署的 TLS termination、Rate limiting 与 Request-size limit 属于外围
  Infrastructure，必须另行配置。

Package 暴露 Health、Snapshot、Plan、Query 与单 Projection Resource 操作。
Action 和 Event 使用 SDK/Action Runtime contract；不要新增手写领域 Route。

## Registry

Registry 发现和分发 Model、Corpus、Adapter、Domain 与 Plugin Package。Record
需要保留 Package kind、Version、Digest、Compatibility、Provenance 与 Signature
metadata。

当前 Remote 与 `@skill-wiki/*` 名称都是兼容位置。在外部服务真实存在并且
Publish/Install round-trip 通过前，文档不能宣称 `kernary.dev` Registry 或
`@kernary/*` 已发布。
