# 领域扩展指南

本指南说明如何在不修改任何 TypeScript 代码的情况下，为 Prime Wiki 添加新的知识领域。只需在知识库目录中放入一个 `domain.yaml` 文件即可。

---

## 零内置领域

Prime Wiki **不内置任何硬编码领域**。运行时中没有 `FRONTEND_DESIGN_DOMAIN` 常量。每个领域——包括 `prime-corpus-frontend-design` 自带的那些——都来自 `domain.yaml` 文件。

这意味着你的 `domain.yaml` 是真正的一等公民，而非"用户扩展"的二等位置。内置知识库附带的领域（`frontend-design`、`security`、`accessibility`）与你的领域使用完全相同的机制。

---

## 为什么要配置驱动？

在此之前，添加 `security`、`machine-learning` 或 `cooking` 等领域需要修改 TypeScript 源码、重新编译并重新部署。每个有自定义语料库的团队都不得不 fork 服务器自行维护。

配置驱动方案的核心原则只有一条：**领域是数据文件，不是代码**。在 `domain.yaml` 中描述领域，运行时启动时自动加载。无需 fork，无需编译，无需重新部署（动态热更新计划在未来版本中实现，当前仍需重启）。

---

## 五分钟快速上手

![领域扩展流程 —— 放一份 YAML、重启、即用](../../assets/domain-extension-flow.png)

**第一步.** 复制示例配置：

```bash
cp examples/recipes/domain.yaml corpora/my-domain/domain.yaml
```

**第二步.** 修改三个必填字段：

```yaml
name: my-domain           # 连字符格式，在所有已加载领域中唯一
version: "1.0.0"
description: 用一句话说明这个知识库覆盖的内容。
```

**第三步.** 将 `tags:` 替换为用户在查询时自然会写出的词汇：

```yaml
tags:
  - my-domain
  - 核心概念
  - 关键术语
  - 关键术语的同义词
```

**第四步.** 重启 MCP 服务器（或 `prime` CLI），领域即刻注册：

```
[prime-wiki] config-driven domains loaded: my-domain
[prime-wiki] domain registry: my-domain
```

**第五步.** 运行查询验证：

```bash
prime query "如何完成核心概念相关的任务"
```

---

## 发现机制

启动时，`discoverDomains()` 从工作目录（或 `AOE_DOMAINS_DIR`）开始递归遍历，查找所有 `domain.yaml` 文件，最多向下扫描 **4 层目录**（`MAX_DISCOVERY_DEPTH = 4`）。`node_modules/` 目录和以 `.` 开头的隐藏目录会被自动跳过。

```
启动
  ↓
discoverDomains(rootDir)
  ↓
  递归遍历 rootDir（深度 ≤ 4）
  查找所有 domain.yaml（跳过 node_modules 和隐藏目录）
  ↓
  按路径字典序排序后逐个处理：
    解析 YAML → 校验模式 → 构建 DomainPlugin
    若名称已存在：记录警告并跳过（先到先得）
    否则：加入列表
  ↓
registerAll(registry, plugins)
  ↓
DomainRegistry 包含所有配置加载的领域
  ↓
用户发送查询 → MCP 服务器
  ↓
detectBriefDomains(brief)
  遍历 registry.names()
  对每个领域：检查 plugin.tags 是否在简报文本中出现
  → 返回 Set<领域名称>
  ↓
rankAtoms(atoms, briefDomains)
  匹配简报领域的 atom → 评分加成
  ↓
排名结果返回给用户
```

### 环境变量

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `AOE_DOMAINS_DIR` | 当前工作目录 | 覆盖扫描根目录。设置后，只扫描该目录下直接的 `*/domain.yaml`（一层，不递归）。 |

示例：

```bash
AOE_DOMAINS_DIR=/teams/legal/corpora prime query "司法意见的引用格式"
```

---

## 完整字段参考

### 必填字段

#### `name`

领域的稳定标识符。用作注册表的键、作用域过滤器和 atom `domain:` 字段匹配。

- 类型：字符串
- 格式：连字符格式（`[a-z0-9-]+`），1–64 个字符
- 在同一进程中所有已加载的领域中必须唯一

若两个 `domain.yaml` 声明了相同的 `name`，按字典序路径排在前面的优先注册，第二个会被跳过并记录警告。

#### `version`

此领域配置的版本，遵循语义版本规则。

```yaml
version: "1.0.0"
```

在 YAML 中始终给版本加引号，防止解析器去掉尾部的零。

#### `description`

领域的一句话描述，显示在 `prime domains --list` 输出中。

- 类型：字符串，1–512 个字符

---

### 可选字段

#### `tags`

领域的标准标签词汇表，用途有两个：

1. **简报扫描**：当用户简报包含标签中的词汇时，该领域的 atom 在检索时获得评分加成。
2. **作用域检查**：将 atom 的 `tags:` 字段与词汇表比对，判断 atom 是否属于该领域。

- 类型：字符串数组，最多 200 项
- **支持 Unicode**：可以使用任何语言的字母和数字（中文、日文、希腊文、拉丁文等）

```yaml
tags:
  - cooking
  - 烹饪
  - スケ
  - αβγ
```

**匹配规则：**
- ASCII 标签：不区分大小写（双方均转小写后比较）。
- 非 ASCII 标签：字面量精确匹配。建议以用户在简报中实际输入的形式存储。

没有自动 ASCII 转写机制——若需同时匹配 `sauté` 和 `saute`，需在 `tags` 列表中同时列出两者。

#### `axes`

检索轴是简报中领域特定的维度。MCP 服务器解析简报时，统计每个轴的 `matches` 中出现了多少词来打分；得分高的轴将检索偏向覆盖该维度的 atom。

```yaml
axes:
  - name: cuisine
    description: 地区或风格烹饪传统。
    matches:
      - italian
      - french
      - japanese
      - chinese

  - name: technique
    description: 简报中提及的烹饪方法。
    matches:
      - braise
      - sous-vide
      - grill

  - name: skill-level
    description: 目标厨师的技能层级。
    matches:
      - beginner
      - intermediate
      - advanced
```

省略 `axes` 时，使用单一的 `general` 轴，不提供维度特定的偏向。

#### `contract`

组合契约模式声明了检索调用的 `contract:` 块中哪些特定于领域的字段有效。每个领域都隐式支持 `must_include` 和 `must_avoid`；此部分在此基础上添加字段。

```yaml
contract:
  required_techniques:
    type: string-array
    description: 至少一个 atom 必须引用的烹饪技巧。

  dietary_constraints:
    type: enum-array
    values: [vegetarian, vegan, gluten-free, dairy-free, halal, kosher]
    description: 检索结果中 atom 必须满足的饮食限制。
```

支持的字段类型：`atom-id-array`、`string-array`、`enum`、`enum-array`、`string`、`boolean`。

#### `validators`

验证器是检索后的质量检查。在检索返回的 atom 上运行，违反领域规则时发出诊断信息，但**不会**过滤 atom。

```yaml
validators:
  - name: mentions-temperature
    description: braise 类 atom 必须提及温度值。
    checker: regex:/(\d+\s*°[FC]|low|medium|high)/i
```

支持 `builtin:<名称>` 和 `regex:<模式>` 两种形式。正则表达式必须采用 `/pattern/flags` 格式；无效正则在加载时记录警告并跳过。

---

## 从 v0.0.x 代码定义领域的迁移指南

v0.0.x 版本的 `@aoe/runtime` 导出了 `FRONTEND_DESIGN_DOMAIN` 和 `createDefaultDomainRegistry`，两者均已移除。

**迁移前（v0.0.x）：**

```typescript
import { FRONTEND_DESIGN_DOMAIN, createDefaultDomainRegistry } from "@aoe/runtime";
const registry = createDefaultDomainRegistry(); // 自动注册 frontend-design 领域
```

**迁移后（v0.1.0+）：**

```typescript
import { loadDomainFromFile, DomainRegistry, registerAll } from "@aoe/runtime";

const registry = new DomainRegistry();
registerAll(registry, [
  loadDomainFromFile("path/to/prime-corpus-frontend-design/domains/frontend-design.yaml"),
]);
```

或使用自动发现工厂函数（推荐用于 MCP 服务器启动）：

```typescript
import { createConfigDrivenRegistry } from "@aoe/runtime";
// 递归扫描 cwd 下的 domain.yaml 文件（深度 ≤ 4）
const registry = createConfigDrivenRegistry();
```

原来 TypeScript 代码中的标签词汇已移至：
- `prime-corpus-frontend-design/domains/frontend-design.yaml`
- `prime-corpus-frontend-design/domains/security.yaml`
- `prime-corpus-frontend-design/domains/accessibility.yaml`

---

## 迁移：我有没有 domain.yaml 的 v0.1.0 知识库怎么办？

**什么都不用做。** 没有 `domain.yaml` 的知识库与之前完全一样正常工作：

- atom 仍然可以通过全文搜索查询。
- atom 在排名中不受领域偏向。
- 不运行领域特定的验证器。

唯一的区别是缺少基于领域的检索加成。**最小迁移配置：**

```yaml
name: my-existing-corpus
version: "1.0.0"
description: 这个知识库覆盖内容的简短说明。
```

放在 `corpora/my-existing-corpus/domain.yaml` 并重启即可。

---

## 故障排除

### 领域未加载

**检查文件深度**：文件必须在工作目录（或 `AOE_DOMAINS_DIR`）的 4 层目录以内。

**检查 YAML 解析错误**：查找启动日志中的 `WARN: skipped domain.yaml` 行。

**手动校验**：

```typescript
import { loadDomainFromFile } from "@aoe/runtime";
const p = loadDomainFromFile("corpora/my-domain/domain.yaml");
console.log(p.name, p.tags.length, "个标签");
```

### 领域加载了但检索忽略了我的 atom

**检查标签重叠**：`domain.yaml` 标签和 atom 的 `tags:` 字段必须至少有一个共同词。

**检查 domain: 字段**：验证 atom 有 `domain: your-domain-name`（精确匹配，不区分大小写）。

**检查简报措辞**：简报-领域检测是子字符串扫描，需要添加所有可能的词形变体。

### 两个 domain.yaml 定义了相同的名称

```
[prime-domain] WARN duplicate domain "cooking": keeping /path/alpha/domain.yaml, ignoring /path/beta/domain.yaml
```

按字典序路径排在前面的优先注册。重命名其中一个领域或将两个 `domain.yaml` 合并为一个。

---

## v0.1.0 不包含的功能

- **自定义 atom 类型**：28 个内置类型是固定的。
- **自定义边关系动词**：14 个内置动词是固定的。
- **LLM 评判验证器**：仅支持 `builtin:*` 和 `regex:*`。
- **跨领域组合**：单次检索调用只能针对一个领域。
- **领域继承**：不能声明 `extends: another-domain`。
- **动态热更新**：编辑 `domain.yaml` 需要重启服务器。

---

## 完整示例

随附示例：

- `examples/recipes/domain.yaml` — 烹饪领域，15 个 atom 的知识库
- `examples/coding-style/domain.yaml` — 团队编码风格，以 TypeScript 为中心

前端设计知识库的内置领域：

- `prime-corpus-frontend-design/domains/frontend-design.yaml`
- `prime-corpus-frontend-design/domains/security.yaml`
- `prime-corpus-frontend-design/domains/accessibility.yaml`
