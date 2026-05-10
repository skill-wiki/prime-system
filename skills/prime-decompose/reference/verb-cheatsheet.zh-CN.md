# 14 种边动词——使用时机速查表

| 动词 | 使用时机 | 示例 |
|---|---|---|
| `related` | 两个原子相互参照，但互不依赖。**默认动词。** 每个原子目标 ≥ 3 个。 | `pattern-toast-stack related @community/template-spring-config` |
| `compatible` | 两个原子（通常是 `persona`）可同时加载而不产生冲突，组合器可同时使用两者。 | `persona-vercel-clean compatible persona-swiss-modernist` |
| `conflicts` | 两个原子互斥，组合器必须二选一。谨慎使用——仅用于真正的美学/语义冲突。 | `persona-brutalist conflicts persona-magazine-editorial` |
| `see-also` | 纯交叉引用，无语义约束。"你可能也想读 X"，但 X 不是必要的。 | `fact-miller-rule see-also fact-hick-law` |
| `extends` | A 继承 B 的所有字段并覆盖指定字段。**实践中仅用于 persona。** | `persona-tokyo-minimal extends @impeccable/persona-notion-warm` |
| `derived-from` | A 是 B 的非继承性衍生（通常是引用）。当你的原子基于外部规范或论文时使用。 | `rule-contrast-aa derived-from @w3c/wcag-2.2-1.4.3` |
| `requires` | 若 A 被加载，B 必须也加载。**强依赖。** 谨慎使用；组合器强制执行。 | `method-heuristic-review requires @nielsen/taxonomy-10-heuristics` |
| `enhances` | B 改善 A 但不是必须的。**软依赖。** | `persona-editorial enhances voice-precise-technical` |
| `validates-with` | A 的正确性由 B 验证。在 `rule` → `source` 或 `rule` → `check` 上使用。 | `rule-color-contrast validates-with @w3c/wcag-2.2-1.4.3` |
| `supplies-to` | A 是被 B 消费的值/资源。`requires` 从值侧的逆向。 | `value-touch-target-min supplies-to rule-touch-target-min` |
| `specializes` | A 是 B 的更窄子类型。 | `persona-magazine-editorial specializes @impeccable/persona-editorial` |
| `contradicts` | A 和 B 做出语义上对立的断言。**L3 标记**——当两者同时加载时，交叉校验器发出警告。刻意使用。 | `rule-no-pure-white contradicts fact-white-is-neutral` |
| `relationships` | 旧版原子的通用兜底。**新编写时避免**——请选择具体的动词。 | — |
| `includes` | `collection` 原子枚举其成员，仅用于 `collection` 类型。 | `collection-frontend-design includes [pattern-..., rule-...]` |

## 编写规则

每个新原子**必须**具备：

1. **≥ 3 个 `related:` 边**（非 `related` 的任何动词都不计入此配额——`related:` 是独立字段）。
2. **≥ 1 个**：`extends`、`derived-from`、`requires`、`enhances`、`specializes`。

若找不到 3 个相关同级，你的原子要么：
- 范围有误（拆分为多个更小的原子），要么
- 是孤立原子（源文档上下文不足——标记此情况并询问人类）。
