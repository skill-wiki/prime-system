# 领域扩展规范

**规范版本：** 0.2.0
**状态：** 草稿
**作者：** Prime Wiki 维护者
**日期：** 2026-05-09

---

## 1. 目的与范围

本规范描述 Prime Wiki 运行时的配置驱动领域扩展机制，定义：

- `domain.yaml` 文件的 schema
- 系统如何在启动时发现并加载领域文件
- 领域配置如何映射到现有 `DomainPlugin` 接口
- 检索、组合和验证在运行时如何使用领域配置
- 规范本身的版本管理规则
- 明确延至未来规范版本的事项

### 解决的问题

此前，每个知识领域都需要在服务器启动时手工注册一个 TypeScript 对象。添加 `security`、`machine-learning` 或 `cooking` 意味着：

1. 编辑 TypeScript 源代码，硬编码一个带有标签词汇表的 `DomainPlugin` 对象。
2. 重新编译并重新部署 MCP 服务器。

这造成了"fork 才能扩展"的模式：任何拥有非标准语料库的团队都必须维护一个打过补丁的服务器副本。本文描述的配置驱动方案消除了这种阻力。团队只需在语料库旁放一个 YAML 文件，系统在启动时自动加载，无需任何代码修改。

### 本规范不涵盖的内容

详见第 9 节（明确排除在外的未来扩展）。主要条目有：

- 超出 28 种内置类型的自定义原子类型
- 超出 14 种内置动词的自定义边动词
- LLM 判断型验证器（v0.1.0 仅支持基于规则和正则的验证器）
- 跨领域组合（单次检索调用跨多个领域的原子）

---

## 2. 无内置领域

**系统不包含任何硬编码领域。** 所有领域都是配置。`frontend-design`、`security` 和 `accessibility` 没有特殊代码路径——它们都是随各自语料库包发布的普通 `domain.yaml` 文件。

这意味着：

- 启动时创建的 `DomainRegistry` 在 `discoverDomains()` 运行前始终为空。
- 捆绑语料库（如 `prime-corpus-frontend-design`）在 `domains/` 子目录中随附自己的 `domain.yaml` 文件。用户可以像编辑任何配置文件一样编辑、禁用或替换它们。
- 不存在"内置 vs 配置"的优先级之分。谁先注册谁生效。

### 从 FRONTEND_DESIGN_DOMAIN（v0.0.x）迁移

如果你在 v0.0.x 代码中导入了 `FRONTEND_DESIGN_DOMAIN` 或 `createDefaultDomainRegistry`：

```typescript
// 之前（v0.0.x）— 已移除
import { FRONTEND_DESIGN_DOMAIN, createDefaultDomainRegistry } from "@prime-lang/runtime";
const registry = createDefaultDomainRegistry();
```

替换为：

```typescript
// 之后（v0.1.0+）— 从语料库的 domain.yaml 加载
import { loadDomainFromFile, DomainRegistry, registerAll } from "@prime-lang/runtime";
const registry = new DomainRegistry();
registerAll(registry, [
  loadDomainFromFile("./corpora/frontend-design/domain.yaml"),
]);
```

或使用便捷工厂：

```typescript
import { createConfigDrivenRegistry } from "@prime-lang/runtime";
// 扫描 cwd/corpora/** 下的 domain.yaml 文件（深度 ≤ 4）
const registry = createConfigDrivenRegistry();
```

领域内容（标签词汇表、轴、约束 schema）已移至：
- `prime-corpus-frontend-design/domains/frontend-design.yaml`
- `prime-corpus-frontend-design/domains/security.yaml`
- `prime-corpus-frontend-design/domains/accessibility.yaml`

---

## 3. `domain.yaml` 文件

### 3.1 概述

领域作者为每个领域创建一个 `domain.yaml` 文件，放置在语料库目录根目录，与 Prime 源文件相邻或相近。

**规范位置：**

```
corpora/
  <corpus-name>/
    domain.yaml        ← 配置文件
    sources/
      @<corpus-name>/
        *.prime
```

`domain.yaml` 是固定顶层结构的 YAML 文档（YAML 1.2）。所有字段详见第 4 节。

### 3.2 最小示例

最小有效的 `domain.yaml` 仅包含三个必填字段：

```yaml
name: cooking
version: "1.0.0"
description: Domain plugin for cooking knowledge corpora.
```

仅有这三个字段，领域注册时拥有空标签词汇表和单个 `general` 轴，组合约束默认为仅 `must_include` + `must_avoid`。这足以防止与其他领域的冲突，但不提供检索偏置。

### 3.3 完整示例（烹饪领域）

```yaml
# corpora/recipes/domain.yaml
name: cooking
version: "1.0.0"
description: Domain plugin for cooking knowledge corpora.

tags:
  - cooking
  - recipe
  - cuisine
  - cook
  - bake
  - simmer
  - braise
  - roast
  - grill
  - season
  - meal-prep
  - technique
  - ingredient
  - temperature
  - flavor
  - fond
  - emulsion
  - maillard
  - mise-en-place

axes:
  - name: cuisine
    description: Regional or stylistic origin (italian, japanese, mexican, ...)
    matches:
      - italian
      - french
      - japanese
      - mexican
      - chinese
      - indian
      - thai
      - mediterranean
      - american
      - korean

  - name: technique
    description: Cooking method applied (braise, sous-vide, grill, ...)
    matches:
      - braise
      - sous-vide
      - grill
      - roast
      - steam
      - poach
      - fry
      - bake
      - smoke
      - deglaze

  - name: skill-level
    description: Intended skill tier of the cook
    matches:
      - beginner
      - easy
      - simple
      - intermediate
      - advanced
      - expert
      - professional

contract:
  must_include:
    type: atom-id-array
    description: Atoms that must appear in the retrieved set.
  must_avoid:
    type: atom-id-array
    description: Atoms that must be excluded from the retrieved set.
  required_techniques:
    type: string-array
    description: Cooking techniques that must be cited by at least one atom.
  dietary_constraints:
    type: enum-array
    values:
      - vegetarian
      - vegan
      - gluten-free
      - dairy-free
      - halal
      - kosher

validators:
  - name: cite-source
    description: Every fact atom must have an attributed_to or source field.
    checker: builtin:every-fact-has-source

  - name: technique-pairs-with-temp
    description: Atoms tagged "braise" must mention a temperature value.
    checker: regex:/(\blow\b|\bmedium\b|\bhigh\b|\d+\s*°[FC])/
```

### 3.4 完整示例（编码规范领域）

```yaml
# corpora/coding-style/domain.yaml
name: coding-style
version: "1.0.0"
description: Domain plugin for team coding style and software engineering corpora.

tags:
  - coding-style
  - typescript
  - readability
  - maintainability
  - naming
  - types
  - api-design
  - patterns
  - anti-patterns
  - refactoring
  - testing
  - error-handling
  - team
  - principles
  - linting

axes:
  - name: language
    description: Programming language or ecosystem the atom applies to.
    matches:
      - typescript
      - javascript
      - python
      - go
      - rust
      - java
      - kotlin

  - name: scope
    description: Where in the codebase the guidance applies.
    matches:
      - public-api
      - internal
      - shared-package
      - prototype
      - test

contract:
  must_include:
    type: atom-id-array
    description: Atoms that must appear in the retrieved set.
  must_avoid:
    type: atom-id-array
    description: Atoms that must not appear in output.
  enforcement_level:
    type: enum
    values:
      - error
      - warning
      - suggestion
    description: Minimum enforcement tier for included rules.

validators:
  - name: rule-has-checks
    description: Every rule atom must have a non-empty checks field.
    checker: builtin:rule-has-checks

  - name: anti-pattern-has-solution
    description: Every anti-pattern atom must have a related pattern atom.
    checker: builtin:anti-pattern-has-counterpart
```

---

## 4. Schema 参考

本节是规范性 schema 定义。每个字段都标注了类型、是否必填、默认值、验证规则和示例。

### 4.1 顶层字段

#### `name`

| 属性 | 值 |
|-----------|-------|
| 必填 | **是** |
| 类型 | `string` |
| 格式 | kebab-case，1–64 个字符，`[a-z0-9-]+` |
| 唯一性 | 在同一进程中所有已加载领域中必须唯一 |

领域的稳定标识符。用作 `DomainRegistry` 中的键、范围过滤器，以及原子 `domain:` 字段匹配。

**有效示例：**
```yaml
name: cooking
name: security
name: machine-learning
name: legal-contracts
```

**无效示例：**
```yaml
name: Cooking        # 不允许大写
name: my_domain      # 不允许下划线
name: ""             # 不允许空字符串
```

**验证规则：** 正则 `/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/`

#### `version`

| 属性 | 值 |
|-----------|-------|
| 必填 | **是** |
| 类型 | `string` |
| 格式 | 语义版本，`MAJOR.MINOR.PATCH` |

本领域配置的版本。领域配置的版本独立于 Prime Wiki 运行时。遵循 SemVer：向后兼容的修复递增 PATCH，新增可选字段递增 MINOR，破坏性 schema 变更递增 MAJOR。

**有效示例：**
```yaml
version: "1.0.0"
version: "2.3.1"
```

**注意：** 在 YAML 中加引号，防止 YAML 自身的数字解析去除末尾零。

#### `description`

| 属性 | 值 |
|-----------|-------|
| 必填 | **是** |
| 类型 | `string` |
| 长度 | 1–512 个字符 |

描述此领域涵盖内容的人类可读描述。显示在 CLI 输出和注册中心内省中。

```yaml
description: Domain plugin for cooking knowledge corpora.
```

---

### 4.2 `tags`

| 属性 | 值 |
|-----------|-------|
| 必填 | 否 |
| 类型 | `string[]` |
| 默认值 | `[]`（空数组） |
| 元素格式 | Unicode 字母/数字加可选连字符；无前导或末尾连字符；1–64 个字符 |
| 标签正则 | `^[\p{L}\p{N}][\p{L}\p{N}-]{0,62}[\p{L}\p{N}]$\|^[\p{L}\p{N}]$`（`/u` 标志） |

领域的规范标签词汇表。两种用途：

1. **Brief 领域检测：** MCP 服务器扫描用户 brief，查找与领域标签词汇表匹配的词。若找到匹配，该领域中的原子在检索得分上获得加成。
2. **范围检查：** 原子的 `tags:` 字段对照此词汇表检查，以确定启发式运行的领域归属。

**Unicode 标签策略：**

标签接受任何 Unicode 字母和数字（拉丁、CJK、日文、希腊、西里尔等）。标签正则使用 Unicode 属性转义 `\p{L}`（字母）和 `\p{N}`（数字），带 `/u` 标志。标签按编写时原样存储。

Brief 到领域的匹配：
- ASCII 标签不区分大小写匹配：两侧在比较前均转为小写。
- 非 ASCII 标签与小写标签词汇表进行字面量比较。作者应以规范小写形式存储非 ASCII 标签。

**标签编写指导：**
- 包含用户描述该领域工作时最自然书写的最具体术语。
- 包含常见同义词和简称。
- 不要包含通用词——它们会导致错误的领域匹配。
- 建议 10–40 个标签以获得良好覆盖而不过度匹配。

```yaml
tags:
  - cooking
  - recipe
  - bake
  - mise-en-place
  - 烹饪
```

**验证规则：**
- 每个标签必须匹配上述 Unicode 标签正则
- 每个领域最多 200 个标签
- 同一领域内重复标签：警告（不是错误），保留第一次出现

---

### 4.3 `axes`

| 属性 | 值 |
|-----------|-------|
| 必填 | 否 |
| 类型 | `AxisDef[]` |
| 默认值 | `[{ name: "general", description: "Default retrieval axis", matches: [] }]` |

检索轴是 brief 的领域特定维度。MCP 服务器解析 brief 时，通过统计每个轴的 `matches` 中有多少词出现在 brief 中来为每个已注册轴评分。得分高的轴驱动检索时偏向匹配这些维度的原子。

若省略 `axes`，领域以单个 `general` 轴注册，平等匹配所有原子。

#### `axes[].name`

| 属性 | 值 |
|-----------|-------|
| 必填 | **是**（在轴对象内） |
| 类型 | `string` |
| 格式 | kebab-case，1–64 个字符 |

轴的稳定标识符。在检索日志和调试输出中引用。

#### `axes[].description`

| 属性 | 值 |
|-----------|-------|
| 必填 | **是**（在轴对象内） |
| 类型 | `string` |
| 长度 | 1–256 个字符 |

显示在 `prime domains --verbose` 中的人类可读描述。

#### `axes[].matches`

| 属性 | 值 |
|-----------|-------|
| 必填 | **是**（在轴对象内） |
| 类型 | `string[]` |
| 最少元素 | 1 |
| 最多元素 | 500 |
| 元素格式 | 非空字符串，任意大小写（不区分大小写匹配） |

出现在 brief 中时对轴得分有贡献的词或短语。匹配基于子串且不区分大小写。

**未知轴字段**（`name`、`description`、`matches` 之外的字段）为了前向兼容而被容忍，以调试级别日志消息静默忽略。

---

### 4.4 `contract`

| 属性 | 值 |
|-----------|-------|
| 必填 | 否 |
| 类型 | `ContractSchema`（对象） |
| 默认值 | `{ must_include: { type: "atom-id-array" }, must_avoid: { type: "atom-id-array" } }` |

组合约束 schema 声明了针对此领域的检索调用中 `contract:` 块内哪些字段有效。每个领域隐式拥有 `must_include` 和 `must_avoid` 字段。`domain.yaml` 中的 `contract:` 块在此基础上添加领域专属字段。

#### 约束字段类型

`contract:` 下的每个键是一个约束字段定义：

```yaml
<field-name>:
  type: <type>          # 必填
  description: <string> # 可选
  values: [...]         # 仅当 type = enum 或 enum-array 时必填
```

**支持的类型：**

| 类型 | 说明 |
|------|-------------|
| `atom-id-array` | 原子 ID 数组（`@scope/name`） |
| `string-array` | 纯字符串数组 |
| `enum` | 来自固定列表的单个值 |
| `enum-array` | 来自固定列表的值数组 |
| `string` | 单个纯字符串 |
| `boolean` | 真/假标志 |

---

### 4.5 `validators`

| 属性 | 值 |
|-----------|-------|
| 必填 | 否 |
| 类型 | `ValidatorDef[]` |
| 默认值 | `[]`（无额外验证器） |

验证器是领域专属的输出检查，在检索后、返回组合结果给调用方之前运行。

#### `validators[].checker`

v0.1.0 支持两种 checker 形式：

**内置 checker**（`builtin:<name>`）：

| Checker 名称 | 说明 |
|---|---|
| `builtin:every-fact-has-source` | 若任意 `fact` 类原子缺少 `source` 或 `attributed_to` 字段则失败 |
| `builtin:rule-has-checks` | 若任意 `rule` 类原子的 `checks` 字段为空或缺失则失败 |
| `builtin:anti-pattern-has-counterpart` | 若任意 `anti-pattern` 原子没有 `pattern` 类的 `related` 原子则失败 |

**正则 checker**（`regex:<pattern>`）：

```yaml
validators:
  - name: technique-pairs-with-temp
    description: Atoms tagged "braise" must mention a temperature.
    checker: regex:/(\blow\b|\bmedium\b|\bhigh\b|\d+\s*°[FC])/
```

正则在加载时一次性编译。无效正则导致加载警告并跳过该验证器。

---

## 5. 发现机制

### 5.1 启动扫描

`prime` CLI 和 MCP 服务器在启动时使用以下算法扫描 `domain.yaml` 文件：

```
1. 确定搜索根目录：
   a. 若 PRIME_DOMAINS_DIR 已设置，使用该路径作为搜索根目录。
   b. 否则，使用当前工作目录。

2a. 若 PRIME_DOMAINS_DIR 已设置：
    查找匹配 <PRIME_DOMAINS_DIR>/*/domain.yaml 的所有文件
    （仅一级深度，不递归）

2b. 若 PRIME_DOMAINS_DIR 未设置：
    递归遍历 <cwd>，查找任意 domain.yaml，
    停止在根目录以下 MAX_DISCOVERY_DEPTH = 4 层。
    跳过 node_modules/ 和隐藏目录（名称以"."开头）。

3. 按字典序排列发现的路径（跨运行确定性）。

4. 对每个发现的文件，按字典序：
   a. 解析 YAML。
   b. 对照 DomainConfig Zod schema 验证。
   c. 转换为 DomainPlugin 对象。
   d. 若领域名称已出现：记录警告并跳过（先注册者胜）。
   e. 否则：添加到结果。
   f. 出现硬错误：记录警告并跳过该文件，不中止启动。

5. 通过 registerAll() 将返回的插件注册到 DomainRegistry。
```

### 5.2 MAX_DISCOVERY_DEPTH

```typescript
export const MAX_DISCOVERY_DEPTH = 4;
```

此常量限制从根目录向下递归扫描的目录层级数。深度 0 扫描根目录本身；深度 4 扫描器最多下降到 `root/a/b/c/d/`。这防止了对深度嵌套 monorepo 的昂贵扫描，同时仍能找到典型语料库布局中的 domain.yaml：

| 深度 | 示例路径 |
|-------|--------------|
| 0 | `./domain.yaml` |
| 1 | `./corpora/domain.yaml` |
| 2 | `./corpora/recipes/domain.yaml`（最常见） |
| 3 | `./packages/corpus/src/domain.yaml` |
| 4 | `./packages/corpus/src/data/domain.yaml` |

### 5.3 环境变量覆盖

```
PRIME_DOMAINS_DIR=/path/to/my/corpora prime query "..."
```

当 `PRIME_DOMAINS_DIR` 已设置时：
- 扫描根目录变为 `$PRIME_DOMAINS_DIR`。
- 应用的 glob 是相对于 `PRIME_DOMAINS_DIR` 的 `*/domain.yaml`（单层，不递归）。
- 这允许团队在非标准目录布局中维护领域配置。

### 5.4 注册顺序与冲突处理

- 文件按字典序路径加载（跨运行确定性）。
- 若两个 `domain.yaml` 文件声明相同的 `name`，**先发现者胜**，第二个被拒绝并向 stderr 记录警告：

```
[prime-domain] WARN duplicate domain "frontend-design": keeping /path/alpha/domain.yaml, ignoring /path/beta/domain.yaml
```

- 不存在"内置 vs 配置"的优先级概念——该区分已不存在。按字典序遍历时同名下第一个遇到的 domain.yaml 文件完成注册。

### 5.5 优雅降级

格式错误的 `domain.yaml` 不会导致进程崩溃。加载器记录结构化警告：

```
[prime-wiki] WARN: skipped domain.yaml at corpora/my-domain/domain.yaml
  reason: Validation error at "name": Expected string, received undefined
```

系统继续加载其他领域。查询仍然有效；只是没有该领域的检索偏置。

---

## 6. Unicode 标签策略

标签接受任何 Unicode 字母和数字，而不仅限于 ASCII。这支持标签词汇表自然以语料库自身语言表达的多语言语料库。

**标签验证正则（规范性）：**

```
/^[\p{L}\p{N}][\p{L}\p{N}-]{0,62}[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u
```

**有效标签示例：**

```yaml
tags:
  - cooking       # ASCII
  - 烹饪           # 中文
  - αβγ           # 希腊文
  - スケ            # 日文
  - cuisine       # 法语借词（ASCII）
```

**Brief 到领域的匹配行为：**

| 标签类型 | 匹配方式 |
|----------|---------|
| 纯 ASCII | 不区分大小写：`WCAG` 匹配 `wcag` |
| 非 ASCII | 字面量匹配：`烹饪` 仅匹配 `烹饪`（不匹配 `COOKING`） |

非 ASCII 标签的作者应以用户在 brief 中自然输入的形式存储标签。

**不规范化为 ASCII：** 标签按原样存储，不进行音译或规范化为 ASCII。若希望 `sauté` 和 `saute` 都能匹配，请在 `tags` 中同时列出两者。

---

## 7. 运行时集成

### 7.1 检索如何使用配置

启动后，`DomainRegistry` 持有从 `domain.yaml` 文件加载的全套已注册 `DomainPlugin` 对象。注册表的使用方式完全相同，无论插件来自哪个文件。

#### 基于标签的 Brief 检测

```typescript
// MCP 服务器（伪代码，展示合约）
const briefDomains = detectBriefDomains(brief, features);
// 对 briefDomains 中的每个领域 d，其 domain: 字段包含 d 的原子获得检索得分加成。
```

`detectBriefDomains` 遍历所有已注册插件，将 `plugin.tags` 与 brief 文本进行比对。

#### 多轴评分

```typescript
for (const axis of plugin.axes) {
  const axisScore = axis.matches.filter(m =>
    briefText.toLowerCase().includes(m.toLowerCase())
  ).length;
}
```

### 7.2 扩展插件字段

由 `loadDomainFromFile` 生成的 `DomainPlugin` 对象携带基础接口之外的额外字段：

```typescript
interface LoadedDomainPlugin extends DomainPlugin {
  readonly version: string;
  readonly description: string;
  readonly axes: ReadonlyArray<AxisDef>;
  readonly contract: ContractSchema;
  readonly validators: ReadonlyArray<ValidatorDef>;
  readonly sourceFile: string;  // domain.yaml 的绝对路径
}
```

通过 `'sourceFile' in plugin` 来缩窄到此类型。

---

## 8. 规范版本管理

### 8.1 规范变更策略

| 变更类型 | 规范版本递增 | 向后兼容？ |
|---|---|---|
| 添加新的可选字段 | MINOR（0.1.0 → 0.2.0） | 是 |
| 修改已有字段类型 | MAJOR（0.x → 1.0.0） | 否 |
| 删除字段 | MAJOR | 否 |
| 添加新的内置 checker | MINOR | 是 |
| 修改标签匹配语义 | MAJOR | 否 |
| 添加新的约束字段类型 | MINOR | 是 |

### 8.2 未知字段策略（前向兼容）

v0.1.0 加载器使用 `z.object({...}).strip()`（Zod 默认），而非 `.strict()`。`domain.yaml` 中未知的顶层字段被剥离并忽略。这确保了为 spec v0.2.0 编写的 `domain.yaml` 在 v0.1.0 运行时中无错加载。

---

## 9. 安全考虑

### 9.1 正则验证器

用户提供的正则表达式在加载时编译。格式错误或病态正则（ReDoS）可能导致验证器编译失败，或如果编译成功则在运行时引发灾难性回溯。加载器：

1. 在加载时编译正则并捕获 `SyntaxError`。
2. 不尝试检测 ReDoS 模式（v0.1.0 范围外）。

**建议：** 避免在 `checker: regex:` 值中使用量词嵌套模式（如 `(a+)+`）。

### 9.2 YAML 解析

`yaml` 包（v2）在 YAML 解析期间**不**执行任意代码。YAML 1.2 是纯数据格式。

### 9.3 路径穿越

`discoverDomains` 函数使用 Node 的 `path.resolve` 解析路径，并验证每个发现的路径是搜索根目录的子路径。搜索根目录之外的文件被拒绝。这防止了符号链接攻击从语料库目录之外加载 `domain.yaml`。

---

## 10. 明确排除在外的未来扩展（v0.1.0）

### 10.1 自定义原子类型

**v0.1.0 不包含。** 28 种内置类型硬编码在 Prime DSL 语法中。

**未来钩子：** `domain.yaml` 中的顶层 `kinds:` 字段已保留。

### 10.2 自定义边动词

**v0.1.0 不包含。** 14 种内置边动词硬编码。

**未来钩子：** schema 中的 `verbs:` 字段已保留。

### 10.3 LLM 判断型验证器

**v0.1.0 不包含。** `checker` 字段仅支持 `builtin:*` 和 `regex:*` 形式。

**未来钩子：** `checker: llm:<prompt-template-id>` 是计划中的语法。

### 10.4 跨领域组合

**v0.1.0 不包含。** 单次检索调用仅针对一个领域。

### 10.5 领域继承

**v0.1.0 不包含。** 领域无法声明 `extends: another-domain`。

**未来钩子：** 顶层 `extends: <domain-name>` 字段已保留。

### 10.6 动态热重载

**v0.1.0 不包含。** MCP 服务器在启动时一次性扫描 `domain.yaml` 文件。

**未来钩子：** 未来版本可能通过 `PRIME_WATCH_DOMAINS=1` 添加基于文件监视的热重载。

### 10.7 领域目录显式 CLI 标志

**v0.1.0 不包含。** 未来规范版本：`--domains-dir <path>` CLI 标志作为环境变量的替代。

---

## 11. 术语表

| 术语 | 定义 |
|------|------------|
| 领域（Domain） | 语料库覆盖的主题领域（烹饪、安全、法律等）。 |
| DomainPlugin | `DomainRegistry` 中代表已加载领域的运行时对象。 |
| domain.yaml | 描述领域的配置文件，每个语料库目录一个。 |
| 标签词汇表（Tag vocabulary） | `tags:` 中用于 brief 扫描和范围检查的字符串列表。 |
| 检索轴（Retrieval axis） | brief 的具名维度（如菜系类型、技能等级），偏置检索。 |
| 组合约束（Composition contract） | 传递给检索调用的需求集合（must_include、must_avoid、领域专属字段）。 |
| 验证器（Validator） | 验证领域专属质量规则的检索后检查。 |
| 内置 checker（Builtin checker） | 随 Prime 运行时发布、按名称引用的验证器实现。 |
| 正则 checker（Regex checker） | 将原子文本与正则表达式匹配的验证器实现。 |
| 范围检查（scope check） | `DomainPlugin` 上的 `scopeCheck(ast)` 函数，若原子属于该领域则返回 true。 |
| 发现（Discovery） | 启动时扫描文件系统查找 `domain.yaml` 文件的过程。 |
| DomainRegistry | 以领域名称为键的 DomainPlugin 内存映射。 |
| MAX_DISCOVERY_DEPTH | 发现时从根目录向下的最大目录层级数（= 4）。 |

---

## 附录 A：完整 Zod Schema（规范性）

规范 schema 实现于 `packages/runtime/src/domain-config.ts`。下方 TypeScript Zod schema 作为规范性参考复现于此：

```typescript
import { z } from "zod";

// Unicode 感知标签正则：接受任何脚本的字母和数字 + 连字符
const TAG_REGEX = /^[\p{L}\p{N}][\p{L}\p{N}-]{0,62}[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u;

const AxisDefSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}([a-z0-9])?$|^[a-z0-9]$/),
  description: z.string().min(1).max(256),
  matches: z.array(z.string().min(1)).min(1).max(500),
}).passthrough();  // 容忍未知字段（前向兼容）

const ContractFieldTypeSchema = z.enum([
  "atom-id-array",
  "string-array",
  "enum",
  "enum-array",
  "string",
  "boolean",
]);

const ContractFieldSchema = z.object({
  type: ContractFieldTypeSchema,
  description: z.string().optional(),
  values: z.array(z.string()).optional(),
}).passthrough();

const ValidatorDefSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  checker: z.string().min(1),
}).passthrough();

const DomainConfigSchema = z.object({
  name: z.string().regex(
    /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/,
    "name must be kebab-case, 1–64 chars"
  ),
  version: z.string().regex(
    /^\d+\.\d+\.\d+$/,
    "version must be semver (MAJOR.MINOR.PATCH)"
  ),
  description: z.string().min(1).max(512),
  tags: z.array(z.string().regex(TAG_REGEX)).max(200).default([]),
  axes: z.array(AxisDefSchema).default([]),
  contract: z.record(z.string(), ContractFieldSchema).default({}),
  validators: z.array(ValidatorDefSchema).default([]),
});
```

---

## 附录 B：示例目录布局

```
my-project/
  corpora/
    recipes/
      domain.yaml          ← prime 启动时加载（深度 2）
      sources/
        @recipes/
          fact-maillard-reaction-temperature.prime
          method-pan-sauce.prime
          rule-rest-meat-after-cooking.prime
    legal/
      domain.yaml          ← 第二个领域，在 recipes/ 之后加载
      sources/
        @legal/
          principle-plain-language.prime
          rule-statute-citation.prime
  CLAUDE.md
```

从 `my-project/` 运行 `prime query "how do I make a pan sauce"` 时，加载两个领域并返回烹饪偏置的结果。询问 `"cite-style for judicial opinions"` 时，返回法律偏置的结果。

### 带 domains/ 子目录的语料库包

```
prime-corpus-frontend-design/
  domains/
    frontend-design.yaml   ← 在语料库根目录以下深度 2 处加载
    security.yaml
    accessibility.yaml
  primes-v3/
    sources/
      ...
```

---

*DOMAIN-EXTENSION-SPEC v0.2.0 结束*
