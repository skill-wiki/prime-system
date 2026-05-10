# `.prime` DSL — 最小语法 + 6 个真实示例

## 语法

```
File          := WS* Atom WS*                         （每文件一个原子）
Atom          := <kind> <PascalName> "{" Field* "}"
Field         := <hyphen-keyword> ":" Value
Value         := String | TripleString | PipeBlock
              |  Array  | Number  | Boolean
              |  AtomRef | EnumLiteral | RawExpr
String        := "\"" ... "\""
TripleString  := "\"\"\"" ... "\"\"\""           （保留换行）
PipeBlock     := "|" "\n" indented-lines          （管道前缀多行）
Array         := "[" Value ("," Value)* "]"
AtomRef       := "@" <scope> "/" <kebab-id>
                  （裸标记，无引号——解析器与字符串区分）
RawExpr       := 不匹配上述任何形式的内容（兜底）
```

注释：`//` 到行末。尾随逗号：允许。

## 必填字段（每种类型）

```
id: "@<scope>/<kebab-name>"
version: "<semver>"
description: "..."
related: [@scope/atom, ...]
```

## 6 个真实示例（来自 `primes-v3/sources/@community/`）

### 1 — `value`

```
value TouchTargetMin {
  id: "@community/value-touch-target-min"
  version: "1.0.0"
  name: "touch-target-min"
  constant: "44px"
  type: css-length
  domain: accessibility
  rationale: "Apple HIG 最小触摸目标。消除了整类误触无障碍 Bug，与 Fitts 定律对齐。"
  related: [
    @community/metric-target-size,
    @community/check-touch-target-min,
    @community/fact-fitts-law,
  ]
  supplies-to: [
    @community/rule-touch-target-min,
  ]
}
```

### 2 — `rule`

```
rule SpacingRhythm {
  id: "@community/rule-spacing-rhythm"
  version: "1.0.0"
  applies-to: @community/type-html-artifact
  domain: visual-design
  description: "所有垂直间距必须来自单一 8 点尺度：4、8、12、16、24、32、48、64、96、128 px。"
  claim: "每个间距 CSS 值解析为文档尺度中 4 的倍数。"
  severity: medium
  validates-with: [
    @community/fact-consistency-standards,
  ]
  checks: [
    @community/check-spacing-rhythm,
  ]
  related: [
    @community/fact-consistency-standards,
    @community/rule-grid-baseline-aligned,
    @community/anti-pattern-cramped-ui,
    @community/principle-vertical-rhythm,
  ]
}
```

### 3 — `anti-pattern`

```
anti-pattern CrampedUi {
  id: "@community/anti-pattern-cramped-ui"
  version: "1.0.0"
  label: "Cramped UI"
  domain: frontend-design
  description: "过度紧凑的间距损害可读性，使触摸目标相接或重叠。"
  trap: "试图在折叠线以上显示更多内容，导致元素以极小间隙排列。在触控设备上，相接的目标会导致误触。"
  remediation: [
    "在定义的尺度上使用下一级间距 token。",
    "验证所有触摸目标至少达到 44px 高度（@community/rule-touch-target-min）。",
  ]
  related: [
    @community/rule-touch-target-min,
    @community/rule-spacing-rhythm,
    @community/tradeoff-density-vs-comfort,
  ]
}
```

### 4 — `fact`

```
fact MotionAsFeedback {
  id: "@community/fact-motion-as-feedback"
  version: "1.0.0"
  description: "有效的 UI 动效传达状态变化和因果关系，而非装饰。"
  statement: "动画必须传达以下之一：因果关系、来源/连续性、状态变化或空间关系——不满足上述任一者为装饰性开销。"
  confidence: strong
  source: [
    "Pasquale D'Silva，《Transitional Interfaces》（2013）",
    "Material Design 动效原则",
    "Apple HIG — 动效章节",
  ]
  applies-to: [
    "modal 打开/关闭、抽屉滑动、下拉显示",
    "列表重排、乐观更新确认",
    "表单保存/验证反馈",
  ]
  counter-conditions: [
    "品牌表达性营销动效以情感价值换取规则豁免。",
    "加载/进度动画传达状态——通过。",
  ]
  related: [
    @community/fact-easing-cubic-bezier,
    @community/fact-duration-perception-thresholds,
    @community/constraint-animation-pref-respected,
  ]
}
```

### 5 — `check`

```
check SkipLink {
  id: "@community/check-skip-link"
  version: "1.0.0"
  signature: (html: string, context?: object) -> CheckResult
  predicate: |
    body = document.body
    firstFocusable = body.querySelector('a[href], button, [tabindex]:not([tabindex="-1"])')
    if firstFocusable.tagName !== 'A':
      yield { fail: 'first-focusable-not-link' }
  domain: accessibility
  description: "验证跳转到主内容的链接是 <body> 中第一个可聚焦元素。"
  validates: @community/rule-skip-link
  severity: high
  evaluation-method: "automated + manual"
  tools: ["axe-core", "playwright", "lighthouse"]
  related: [
    @community/rule-skip-link,
    @w3c/source-wcag-22,
  ]
}
```

### 6 — `principle`

```
principle VerticalRhythm {
  id: "@community/principle-vertical-rhythm"
  version: "1.0.0"
  domain: frontend-design
  statement: "各节之间的间距必须大于节内各项之间的间距。"
  rationale: "差异化间距在无需显式边框的情况下传达包含关系和层次结构。格式塔接近法则的直接应用。"
  applies-to: ["frontend-design", "design-systems"]
  examples: [
    "节 margin-top: 64px；item gap: 16px——4:1 比例，分组清晰",
    "表单中字段间距 24px，组间距 48px——双倍间距规则",
  ]
  counter-examples: [
    "无论节还是 item，所有 margin 均设为 16px",
    "用 border-bottom: 1px solid 代替间距分隔节",
  ]
  related: [
    @community/fact-fitts-law,
    @community/anti-pattern-cramped-ui,
    @community/rule-spacing-rhythm,
    @community/principle-white-space-as-design-element,
  ]
}
```

## 常见错误

- 给 `@scope/id` 引用加引号（`"@community/foo"`）——**不要这样做**。原子引用是裸标记。
- 忘记末尾的 `}`——每个原子恰好是一个块。
- 缺少 `description`——每种类型都必须有。
- 在新原子中使用 `relationships:`——请使用具体动词（`related:`、`requires:` 等）。
- 在边中发明原子 ID——每个引用的 ID 必须存在。
