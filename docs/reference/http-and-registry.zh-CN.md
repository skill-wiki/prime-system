# HTTP 与 Registry

当 Agent、Web 应用或服务需要跨进程使用 Kernary 时，使用 HTTP Transport；当多个
团队需要发现和分发组成领域的 Package 时，使用 Registry。

## HTTP Service

HTTP 与 Embedded SDK 暴露同一套契约：

```text
health · snapshot · plan · query · resource
                         │
                 preflight · execute · events
```

Server 把 Model 与 Corpus 语义交给 Engine，不需要为每个新 Package 手写一套领域
Route。

### 安全默认值

- 除 `/healthz` 外的 Route 都需要 Bearer credential；
- Principal 来自 Credential，Request body 不能自行指定 Principal；
- Server 默认只绑定 Loopback；
- 暴露到非 Loopback 地址需要显式确认；
- TLS termination、Rate limit、Request-size limit 和 Network policy 属于外围部署。

远程暴露前，请把 Authentication 绑定到带 Tenant/Workspace identity 的 Request
Context，并且只注册已经准备好授权和观测的 Action Provider。

## Registry Service

Registry 是以下 Package 的目录和分发入口：

- Model Package；
- Corpus Package；
- Adapter Package；
- Domain Package；
- Plugin Package。

每条记录应包含 Package kind、name、version、digest、provenance、license、visibility
和 signature metadata。安装过程解析不可变 Release，不应该重写 Package 的 Model 或
Corpus 语义。

当前静态网站提供 Package 发现与 Source 链接；托管 Registry 是单独部署的服务，
实现这套契约。发布前请先阅读 [Package 模型](../concepts/package-model.zh-CN.md)，
确认每项数据应该属于哪一类 Package。
