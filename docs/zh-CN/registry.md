# Registry

Prime registry 是一个小型 HTTP 服务，存 `.prime` 源文件，按 id 提供。
System 仓库**故意带了两个** server，作用范围不同：

| Server | 在哪 | 干什么 |
|---|---|---|
| `scripts/registry-server.ts` | 顶层脚本 | `publish`/`install` 回环测试用的极简 stub。文件系统存储，约 160 行。 |
| `packages/registry/` | 完整 Hono 应用 | 完整 registry —— SQLite、search、评分、依赖图、网页 UI。 |

两个都说 CLI 用的同一组主接口 `GET /atoms/<id>.prime` 和
`PUT /atoms/<id>.prime`。按运维需要选：脚本能跑通回环；package 是
团队自托管时用的。

这页两个都讲，外加把它们粘起来的回环测试。

---

## HTTP 路由（CLI 关心的那部分契约）

CLI（`prime publish`、`prime install --remote`）只用 4 个路由。两个
server 都实现：

| Method | Path | 行为 |
|---|---|---|
| `GET` | `/healthz` | `200 ok\n` |
| `GET` | `/atoms` | `200`，JSON 列出所有 id —— `{ count, atoms: [...] }` |
| `GET` | `/atoms/<id>.prime` | `200` 返回原始 `.prime` body；缺则 `404` |
| `PUT` | `/atoms/<id>.prime` | `201` JSON `{ id, bytes }`；鉴权失败 `401`；body 不合规 `422` |

`<id>` 是 `@scope/kind-slug` 形式，比如 `@community/persona-stripe`。

Package server 还多一组更丰富的路由：

| Method | Path | 行为 |
|---|---|---|
| `GET` | `/api/health` | JSON `{ status, timestamp }` |
| `GET` | `/api/search?q=&type=&tag=&limit=&offset=` | JSON `{ results, count }` |
| `GET` | `/api/primes/:name` | 最新版元数据 |
| `GET` | `/api/primes/:name/:version` | 指定版本 |
| `GET` | `/api/primes/:name/download` | 累加下载计数，返回 `{ source, compiled }` |
| `GET` | `/api/primes/:name/graph` | `{ dependencies, links, reverseLinks }` |
| `GET` | `/api/primes/:name/dependents` | 谁依赖了这个 atom |
| `POST` | `/api/primes` | 发布（带 tag、deps、links 的完整 record） |
| `POST` | `/api/primes/:name/rate` | `{ rating: 1..5 }` |

v1 的 CLI 只用 `/atoms/<id>.prime` 这条路。`/api/primes/...` 那组是
网页 UI 和未来 v2 CLI 用的。

---

## 鉴权

两个 server 都用一个 Bearer token，启动时通过环境变量 `PRIME_REGISTRY_TOKEN`
设：

```bash
PRIME_REGISTRY_TOKEN=secret bun scripts/registry-server.ts
```

设了之后：

- `GET` 不需要鉴权（registry 默认读公开）
- `PUT /atoms/<id>.prime` 必须带 `Authorization: Bearer secret`，否则 `401`

如果 `PRIME_REGISTRY_TOKEN` 没设，**registry 完全开放** —— 任何人都
能 `PUT`。本地开发和回环脚本里这是故意的；不要把没保护的 registry
开到公网。

---

## SQLite schema（package server）

`packages/registry/src/db.ts` 启动时建三张表：

```sql
CREATE TABLE IF NOT EXISTS primes (
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'Knowledge',
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',     -- JSON 数组字符串
  author      TEXT NOT NULL DEFAULT '',
  license     TEXT NOT NULL DEFAULT 'MIT',
  source      TEXT NOT NULL DEFAULT '',       -- 原始 .prime
  compiled    TEXT NOT NULL DEFAULT '',       -- 编译后 .md（可选）
  downloads   INTEGER NOT NULL DEFAULT 0,
  rating_sum  INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, version)
);

CREATE TABLE IF NOT EXISTS dependencies (
  prime_name  TEXT NOT NULL,
  dep_name    TEXT NOT NULL,
  dep_version TEXT NOT NULL DEFAULT '*',
  PRIMARY KEY (prime_name, dep_name)
);

CREATE TABLE IF NOT EXISTS links (
  from_prime TEXT NOT NULL,
  to_prime   TEXT NOT NULL,
  link_type  TEXT NOT NULL DEFAULT 'related',
  PRIMARY KEY (from_prime, to_prime, link_type)
);
```

注意：

- 主键是 `(name, version)` —— 多版本可共存。
- `tags` 是 JSON 字符串，不是真数组列。tag 过滤用 `LIKE '%"foo"%'`，
  单团队 registry 规模够用；过 10 万 atom 的话切到 FTS5。
- `dependencies` 和 `links` 故意分开 —— `dependencies` 是硬
  `requires` 风格，`links` 带语义边类型（related / enhances /
  conflicts / …）。
- 启动时启用 WAL 模式和 foreign keys。
- 存储路径：`packages/registry/data/registry.db`（相对于 package）。

SQLite 文件是唯一的持久状态 —— 备份它、在主机间搬它，按普通 `.db`
处理就行。

脚本 server（`scripts/registry-server.ts`）**不用** SQLite。它每个
atom 一个 `.prime` 文件，存在 `<root>/<scope>/<name>.prime`。这棵树
就是纯文本 —— `rsync` 走、当静态资源桶都行。

---

## 自托管

### 回环 stub（脚本）

```bash
# 默认：端口 7700、存储 ./registry-store、无鉴权
bun run scripts/registry-server.ts

# 指定端口和存储路径
bun run scripts/registry-server.ts --port 8080 --root /var/lib/prime-registry

# 加鉴权
PRIME_REGISTRY_TOKEN=secret bun run scripts/registry-server.ts
```

要端到端测 `prime publish` / `prime install --remote` 而不想架一个
真数据库的时候用脚本。启动 <100ms，按 `--root` 存原始 `.prime` 文件。
没有 UI，没有评分。

### 完整 registry（package）

```bash
# 在 system 仓库根目录
cd packages/registry
bun run src/index.ts
# → +------------------------------------------+
#   |   PRIME Registry — running on :3001      |
#   |   http://localhost:3001                  |
#   +------------------------------------------+
```

`PORT` 环境变量覆盖默认 3001。网页 UI 从 `packages/web/public` 出；
package 编译后访问 `/` 就能看到搜索界面。

生产用的话，前面挂一个 TLS 终结器（Caddy / nginx）。这个服务对
TLS 没意见。

---

## 用 CLI 推 / 拉

CLI 通过 `--remote <url>` 或 `PRIME_REGISTRY` 环境变量指向哪个
server 就跟哪个说话。

**Push**：

```bash
$ PRIME_REGISTRY=http://localhost:7700 \
  PRIME_REGISTRY_TOKEN=secret \
  prime publish primes/@community/persona-stripe.prime

═══ Publishing persona-stripe.prime
  ✅  id:      @community/persona-stripe
  ✅  version: 1.0.0
  ✅  kind:    persona

  ⠋ PUT http://localhost:7700/atoms/@community/persona-stripe.prime
  ✅ Published!
```

**Pull**：

```bash
$ prime install @community/persona-stripe \
  --remote http://localhost:7700 \
  --dir /tmp/dest

  fetched  3 from http://localhost:7700
    + @community/persona-stripe
    + @community/rule-contrast-aaa
    + @community/pattern-card-elevated
```

`prime install --remote` 会递归走依赖图：每个本地缺的 ref 都去 fetch，
新拉到的 atom 自己的 deps 也排进队列。走完仍然缺的，会按 404 和
本地缺失分开列。

---

## 回环冒烟测试

`scripts/test-registry-roundtrip.sh` 是端到端测试的标准动作。它启
脚本 server、发一个 atom、列 `/atoms`、用 `--remote` 装到干净目录、
确认文件落盘且字节数非零。

```bash
bash scripts/test-registry-roundtrip.sh
```

预期输出（最后几行）：

```
==> verify file on disk
    OK — 4127 bytes at /tmp/prime-registry-roundtrip-dest/@community/persona-stripe.prime
==> all assertions passed
    (server log: /tmp/prime-registry-roundtrip.log)
```

测试做的事：

1. `bun scripts/registry-server.ts --port 7790 --root /tmp/prime-registry-roundtrip-store`
   起 server。
2. 轮询 `/healthz` 直到 ready。
3. `prime publish` 发 `primes-v3/sources/@community/persona-stripe.prime`。
4. `curl /atoms` 然后 `grep` id。
5. `prime install @community/persona-stripe --dir /tmp/dest --remote`。
6. install **故意**会非零退出 —— 发的这个 atom 是 6 节点子图里
   一个，5 个 dep 会 404。测试只断言要求的那个 atom 落了盘；
   deps-404 是正常预期。
7. `EXIT` trap 杀 server。

改 publish/install 代码路径时跑一遍。CI 每次 push 都跑这个脚本。

---

## 联邦：多个 registry

Prime 没有中央 registry。CLI 听给的 URL。优先级：

1. `--remote <url>` flag（最高）
2. `PRIME_REGISTRY` 环境变量
3. （没默认值 —— 退到本地模式）

团队可以自架 registry，和公共 registry 并存或替代。Atom id 带
scope（`@scope/name`），团队拿一个自己的 scope 就和别人零冲突。

要做 mirror（从一个 registry 拉再发到另一个）：

```bash
# 简陋但能用
curl -sS http://upstream.example/atoms | jq -r '.atoms[]' | while read id; do
  curl -sS "http://upstream.example/atoms/${id}.prime" \
    | curl -sS -X PUT --data-binary @- \
        -H "Authorization: Bearer $PRIME_REGISTRY_TOKEN" \
        "http://your-registry.example/atoms/${id}.prime"
done
```

一等公民的 `prime mirror <upstream> <downstream>` 在 roadmap，
还没做。

---

## **还没**做的事

诚实清单：

- **跨 registry 搜索。** `prime search` 只打一个 endpoint（或本地）。
  没有联邦搜索。
- **一等的 mirror。** `prime mirror` 不存在。用上面的 shell loop
  或者直接 cp SQLite 文件。
- **遥测 / 审计日志。** Package server 不记谁拉了什么。要的话在反向
  代理层加。
- **Atom 签名。** `.prime` 文件没签。要 provenance 就把 registry
  放在带认证的网络里、对内对你的 git 仓库做对账。
- **PUT 冲突解决。** `PUT` 直接覆盖现有 body。带版本语义
  （`PUT @scope/foo@1.0.0` vs `1.0.1`）在 SQLite schema 里有
  （`PRIMARY KEY (name, version)`），但 `/atoms/<id>.prime` 这条简写
  路径每个 id 只一个槽。
- **限流。** registry 不管，扔到代理层。
- **Tarball 发布。** 每个 atom 单独发。Bundle 显式不在 v1 范围内 ——
  原子粒度是协议契约。

---

## 配方

### 本地 registry，无鉴权

```bash
bun run scripts/registry-server.ts --port 7700 --root ~/prime-store
# 另一个终端：
PRIME_REGISTRY=http://localhost:7700 prime publish primes/foo.prime
PRIME_REGISTRY=http://localhost:7700 prime install @scope/foo
```

### 团队 registry，带鉴权

```bash
# 团队服务器上
PRIME_REGISTRY_TOKEN=$(openssl rand -hex 32) \
  bun run scripts/registry-server.ts --port 7700 --root /var/lib/prime-store

# 通过你的 secret manager 把 token 发给队友。每人：
export PRIME_REGISTRY=https://prime.team.example
export PRIME_REGISTRY_TOKEN=...
prime publish primes/whatever.prime
```

### 备份 / 迁移

```bash
# 脚本 server：纯文件
rsync -av /var/lib/prime-store/ backup-host:/var/lib/prime-store/

# Package server：一个 SQLite 文件
sqlite3 packages/registry/data/registry.db ".backup '/tmp/registry.db.bak'"
scp /tmp/registry.db.bak backup-host:/var/lib/prime-registry/
```

### 看 registry 上有什么

```bash
$ curl -sS http://localhost:7700/atoms | jq
{
  "count": 3,
  "atoms": [
    "@community/persona-stripe",
    "@community/rule-contrast-aaa",
    "@community/pattern-card-elevated"
  ]
}
```

### 健康检查（k8s / 监控）

```bash
curl -fsS http://localhost:7700/healthz   # 仅当返回 "ok\n" 时 exit 0
```

---

## 相关

- `docs/zh-CN/cli.md` §包管理命令 —— `publish`/`install` flag 表。
- `scripts/registry-server.ts` —— 脚本 server 源码，约 160 行，值得读。
- `packages/registry/src/` —— 完整 registry。Hono + SQLite，约 500
  行 TypeScript。
- `scripts/test-registry-roundtrip.sh` —— 端到端冒烟测试。
