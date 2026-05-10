/**
 * Node-runnable smoke tests for the parser.
 *
 * Mirrors the most load-bearing assertions from
 * `parser-28-types.test.ts` and `parser.test.ts` so we can verify
 * grammar changes without requiring `bun:test` (the project policy
 * forbids invoking `bun`).  Run with:
 *
 *   node --experimental-transform-types packages/parser/test/run-node-tests.mjs
 */

import { parse, tokenize, TokenType } from '../src/index.ts';
import { ATOM_KINDS } from '../../types/src/ast.ts';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e?.message || String(e) });
  }
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || ''}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function truthy(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy value');
}

function fieldOf(body, key) {
  return body.find((f) => f.key === key);
}

// ── 1. ATOM_KINDS has 28 entries ──────────────────────────────────────────────
ok('ATOM_KINDS has 28 entries', () => {
  eq(ATOM_KINDS.length, 28, 'ATOM_KINDS length');
});

// ── 2. All 28 kinds parse the minimal form ───────────────────────────────────
const ALL_28 = [
  ['fact', 'fact Demo { label: "ok" }'],
  ['term', 'term Demo { label: "ok" }'],
  ['value', 'value Demo { label: "ok" }'],
  ['category', 'category Demo { label: "ok" }'],
  ['example', 'example Demo { label: "ok" }'],
  ['counter-example', 'counter-example Demo { label: "ok" }'],
  ['source', 'source Demo { label: "ok" }'],
  ['metric', 'metric Demo { label: "ok" }'],
  ['step', 'step Demo { label: "ok" }'],
  ['check', 'check Demo { label: "ok" }'],
  ['transform', 'transform Demo { label: "ok" }'],
  ['tool', 'tool Demo { label: "ok" }'],
  ['method', 'method Demo { label: "ok" }'],
  ['rule', 'rule Demo { label: "ok" }'],
  ['taxonomy', 'taxonomy Demo { label: "ok" }'],
  ['pattern', 'pattern Demo { label: "ok" }'],
  ['anti-pattern', 'anti-pattern Demo { label: "ok" }'],
  ['type', 'type Demo { label: "ok" }'],
  ['persona', 'persona Demo { label: "ok" }'],
  ['voice', 'voice Demo { label: "ok" }'],
  ['constraint', 'constraint Demo { label: "ok" }'],
  ['template', 'template Demo { label: "ok" }'],
  ['provocation', 'provocation Demo { label: "ok" }'],
  ['collection', 'collection Demo { label: "ok" }'],
  ['scope', 'scope Demo { label: "ok" }'],
  ['tradeoff', 'tradeoff Demo { label: "ok" }'],
  ['principle', 'principle Demo { label: "ok" }'],
  ['feedback', 'feedback Demo { label: "ok" }'],
];
for (const [kind, src] of ALL_28) {
  ok(`${kind} parses with kind=${kind}`, () => {
    const { ast, errors } = parse(src);
    eq(errors.length, 0, `errors for ${kind}: ${errors.map((e) => e.message).join('; ')}`);
    eq(ast.type, 'AtomDeclaration', 'ast.type');
    eq(ast.kind, kind, 'ast.kind');
    eq(ast.name, 'Demo', 'ast.name');
  });
}

// ── 3. fact full body ────────────────────────────────────────────────────────
ok('fact full body — string + ident + cross-atom @-string', () => {
  const src = `
fact WcagFocusContrast {
  statement: "Focus ring contrast must be ≥ 3:1 against adjacent colors"
  confidence: proven
  evidence: "@w3c/wcag-2-4-11"
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const f1 = fieldOf(ast.body, 'statement');
  eq(f1.value.type, 'String', 'statement type');
  truthy(f1.value.value.includes('Focus ring'), 'statement contains Focus ring');
  const f2 = fieldOf(ast.body, 'confidence');
  eq(f2.value.type, 'Ident', 'confidence type');
  eq(f2.value.value, 'proven', 'confidence value');
  const f3 = fieldOf(ast.body, 'evidence');
  eq(f3.value.type, 'String', 'evidence type');
  eq(f3.value.value, '@w3c/wcag-2-4-11', 'evidence value');
});

// ── 4. method input/output/uses/body ────────────────────────────────────────
ok('method input is object with two fields', () => {
  const src = `
method DesignCritique {
  input:  { artifact: "URL", depth: "string" }
  output: { issues: "Issue[]", score: "int" }
  uses:   ["@step/load-artifact", "@step/apply-heuristics"]
  body: [
    "@step/load-artifact -> raw"
    "@step/apply-heuristics(raw) -> scores"
  ]
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const f = fieldOf(ast.body, 'input');
  eq(f.value.type, 'Object', 'input type');
  eq(f.value.fields.length, 2, 'input fields length');
  const uses = fieldOf(ast.body, 'uses');
  eq(uses.value.type, 'Array', 'uses type');
  eq(uses.value.items.length, 2, 'uses length');
  eq(uses.value.items[0].value, '@step/load-artifact', 'uses[0]');
});

// ── 5. taxonomy members ─────────────────────────────────────────────────────
ok('taxonomy members array has two items', () => {
  const src = `
taxonomy NielsenHeuristics {
  members: [
    "@fact/visibility-of-system-status"
    "@fact/match-system-real-world"
  ]
  source: "@source/nielsen-1994"
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const m = fieldOf(ast.body, 'members');
  eq(m.value.items.length, 2, 'members length');
});

// ── 6. collection includes ──────────────────────────────────────────────────
ok('collection includes has 3 items', () => {
  const src = `
collection AccessibleFrontend {
  description: "Review any frontend artifact for a11y compliance"
  includes: [
    "@rule/design-health"
    "@method/design-critique"
    "@taxonomy/nielsen-heuristics"
  ]
  orchestration: "@method/design-critique"
  target: claude-code
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const inc = fieldOf(ast.body, 'includes');
  eq(inc.value.items.length, 3, 'includes length');
  truthy(inc.value.items[0].value.includes('@rule'), 'includes[0] @rule');
  truthy(inc.value.items[2].value.includes('@taxonomy'), 'includes[2] @taxonomy');
  const t = fieldOf(ast.body, 'target');
  eq(t.value.type, 'Ident', 'target type');
  eq(t.value.value, 'claude-code', 'target value');
});

// ── 7. cross-atom @-string in scalar/array ──────────────────────────────────
ok('@-prefixed string in scalar field', () => {
  const src = `method Foo { uses: "@step/load" }`;
  const { ast } = parse(src);
  const f = fieldOf(ast.body, 'uses');
  eq(f.value.type, 'String', 'type');
  eq(f.value.value, '@step/load', 'value');
});
ok('@-prefixed strings in array field', () => {
  const src = `collection Foo { includes: ["@rule/x", "@method/y", "@taxonomy/z"] }`;
  const { ast } = parse(src);
  const f = fieldOf(ast.body, 'includes');
  eq(f.value.items.length, 3, 'len');
  for (const item of f.value.items) {
    eq(item.type, 'String', 'item type');
    truthy(item.value.startsWith('@'), 'starts with @');
  }
});

// ── 8. atom-kind keywords as field names ─────────────────────────────────────
ok("'method', 'rule', 'type' as field keys", () => {
  const src = `fact Foo { method: "x" rule: "y" type: "z" }`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  truthy(fieldOf(ast.body, 'method'), 'method');
  truthy(fieldOf(ast.body, 'rule'), 'rule');
  truthy(fieldOf(ast.body, 'type'), 'type');
});

// ── 9. lexer tokenizes 28 keywords ──────────────────────────────────────────
ok('lexer tokenizes all 28 keyword strings to correct token types', () => {
  const map = [
    ['fact', TokenType.FACT],
    ['term', TokenType.TERM],
    ['value', TokenType.VALUE],
    ['category', TokenType.CATEGORY],
    ['example', TokenType.EXAMPLE],
    ['counter-example', TokenType.COUNTER_EXAMPLE],
    ['source', TokenType.SOURCE],
    ['metric', TokenType.METRIC],
    ['step', TokenType.STEP],
    ['check', TokenType.CHECK],
    ['transform', TokenType.TRANSFORM],
    ['tool', TokenType.TOOL],
    ['method', TokenType.METHOD],
    ['rule', TokenType.RULE],
    ['taxonomy', TokenType.TAXONOMY],
    ['pattern', TokenType.PATTERN],
    ['anti-pattern', TokenType.ANTI_PATTERN],
    ['type', TokenType.TYPE],
    ['persona', TokenType.PERSONA],
    ['voice', TokenType.VOICE],
    ['constraint', TokenType.CONSTRAINT],
    ['template', TokenType.TEMPLATE],
    ['provocation', TokenType.PROVOCATION],
    ['collection', TokenType.COLLECTION],
    ['scope', TokenType.SCOPE],
    ['tradeoff', TokenType.TRADEOFF],
    ['principle', TokenType.PRINCIPLE],
    ['feedback', TokenType.FEEDBACK],
  ];
  for (const [word, expectedType] of map) {
    const tokens = tokenize(word).filter(
      (t) => t.type !== TokenType.EOF && t.type !== TokenType.NEWLINE
    );
    eq(tokens.length, 1, `tokens for ${word}`);
    eq(tokens[0].type, expectedType, `type for ${word}`);
    eq(tokens[0].value, word, `value for ${word}`);
  }
});

// ── 10. legacy prime syntax ─────────────────────────────────────────────────
ok('prime X extends Knowledge { } still PrimeDeclaration', () => {
  const src = `prime OWASPTop10 extends Knowledge { name: "owasp-top-10" version: "1.0.0" }`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, 'errors');
  eq(ast.type, 'PrimeDeclaration', 'ast.type');
  eq(ast.name, 'OWASPTop10', 'name');
  eq(ast.extends, 'Knowledge', 'extends');
});

// ── 11. empty body ──────────────────────────────────────────────────────────
ok('atom with empty body', () => {
  const { ast } = parse(`principle Empty {}`);
  eq(ast.body.length, 0, 'body empty');
});

// ── 12. filename tracking ───────────────────────────────────────────────────
ok('filename tracking', () => {
  const { ast } = parse(`fact Foo { label: "ok" }`, 'foo.prime');
  eq(ast.type, 'AtomDeclaration', 'type');
  eq(ast.filename, 'foo.prime', 'filename');
});

// ── 13. NEW: @scope/atom-id is captured as a single STRING token ────────────
ok('@scope/atom-id lexes as a single STRING token', () => {
  const tokens = tokenize('evidence: @w3c/source-wcag-22').filter(
    (t) => t.type !== TokenType.EOF && t.type !== TokenType.NEWLINE
  );
  eq(tokens.length, 3, 'token count');
  eq(tokens[2].type, TokenType.STRING, 'last token is STRING');
  eq(tokens[2].value, '@w3c/source-wcag-22', 'value');
});

// ── 14. NEW: triple-quoted string ───────────────────────────────────────────
ok('triple-quoted strings carry multi-line content', () => {
  const src = `tool X { body: """
    line one
    line two
  """ }`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const f = fieldOf(ast.body, 'body');
  eq(f.value.type, 'String', 'type');
  truthy(f.value.value.includes('line one'), 'contains line one');
  truthy(f.value.value.includes('line two'), 'contains line two');
});

// ── 15. NEW: block scalar `|` ───────────────────────────────────────────────
ok('block scalar |', () => {
  const src = `check X {
  predicate: |
    foo
    AND bar
  next: 42
}`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const f = fieldOf(ast.body, 'predicate');
  eq(f.value.type, 'String', 'predicate type');
  truthy(f.value.value.includes('foo'), 'contains foo');
  truthy(f.value.value.includes('AND bar'), 'contains AND bar');
  const n = fieldOf(ast.body, 'next');
  eq(n.value.type, 'Number', 'next is number');
  eq(n.value.value, 42, 'next == 42');
});

// ── 16. NEW: function signature captured as raw string ──────────────────────
ok('function signature value is captured raw', () => {
  const src = `check Foo { signature: (element: DOMElement) -> bool }`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const f = fieldOf(ast.body, 'signature');
  eq(f.value.type, 'String', 'sig type');
  truthy(f.value.value.includes('DOMElement'), 'contains DOMElement');
});

// ── 17. NEW: type union in object body ──────────────────────────────────────
ok('type union & string[] inside object body', () => {
  const src = `type X { fields: { a: string | number, b: string[] } }`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const f = fieldOf(ast.body, 'fields');
  eq(f.value.type, 'Object', 'fields type');
  const a = f.value.fields.find((x) => x.key === 'a');
  truthy(a, 'has a');
  eq(a.value.type, 'String', 'a value is captured as String');
  truthy(a.value.value.includes('|'), 'contains |');
  const b = f.value.fields.find((x) => x.key === 'b');
  truthy(b, 'has b');
});

// ── 18. NEW: string-keyed and number-keyed object entries ───────────────────
ok('string-keyed object body', () => {
  const src = `feedback X { adj: { "@a/c": 0.95, "@a/d": 0.7 } }`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const f = fieldOf(ast.body, 'adj');
  eq(f.value.type, 'Object', 'adj type');
  eq(f.value.fields.length, 2, 'two entries');
  eq(f.value.fields[0].key, '@a/c', 'first key');
});
ok('number-keyed object body', () => {
  const src = `taxonomy X { scale: { 0: "none", 1: "minor", 2: "major" } }`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const f = fieldOf(ast.body, 'scale');
  eq(f.value.type, 'Object', 'scale type');
  eq(f.value.fields.length, 3, 'three entries');
  eq(f.value.fields[0].key, '0', 'first key');
});

// ── 19. Legacy: nested object (author) ──────────────────────────────────────
ok('legacy prime nested author object', () => {
  const src = `
prime OWASPTop10 extends Knowledge {
  name: "owasp-top-10"
  version: "1.3.0"
  tags: ["security", "web"]
  author: { name: "OWASP Foundation", url: "https://owasp.org" }
}
`;
  const { ast, errors } = parse(src, 'owasp.prime');
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const author = fieldOf(ast.body, 'author');
  eq(author.value.type, 'Object', 'author type');
  const inner = author.value.fields.find((x) => x.key === 'name');
  eq(inner.value.value, 'OWASP Foundation', 'author name');
  eq(ast.filename, 'owasp.prime', 'filename');
});

// ── 20. Legacy: steps with shorthand ────────────────────────────────────────
ok('legacy method with steps RED/GREEN/REFACTOR', () => {
  const src = `
prime TDDRedGreenRefactor extends Method {
  name: "tdd"
  version: "2.1.0"

  steps: [
    RED {
      "Write a test describing expected behavior. Run the test."
      expect: fail
      error: "Test passed — not testing new behavior, rewrite test"
    }

    GREEN {
      "Write minimal code to make the test pass. Run the test."
      expect: pass
      error: {
        message: "Test did not pass"
        retry: 3
        fallback: "Go back to task and re-understand requirements"
      }
    }

    REFACTOR {
      "Eliminate duplication, improve naming, simplify."
      expect: pass
      error: "Refactoring broke tests — rollback to last GREEN"
    }
  ]
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const steps = fieldOf(ast.body, 'steps');
  eq(steps.value.items.length, 3, 'three steps');
  eq(steps.value.items[0].name, 'RED', 'first is RED');
  eq(steps.value.items[1].name, 'GREEN', 'second is GREEN');
});

// ── 21. Threshold shorthand ────────────────────────────────────────────────
ok('threshold shorthand parses', () => {
  const src = `
prime TestCoverage extends Rule {
  thresholds: [
    line_coverage     block: < 60%   warn: < 80%   pass: >= 80%
    branch_coverage   block: < 50%   warn: < 70%   pass: >= 70%
  ]
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const t = fieldOf(ast.body, 'thresholds');
  truthy(t.value.items.length >= 2, 'two thresholds');
  const first = t.value.items[0];
  eq(first.type, 'Threshold', 'is Threshold');
  eq(first.metric, 'line_coverage', 'metric');
});

// ── 22. Inheritance: override / append / extend ─────────────────────────────
ok('override / append / extend pseudo-fields', () => {
  const src = `
prime SecurityCodeReview extends BaseCodeReview {
  override steps.ANALYZE {
    "Evaluate each change for security threats using STRIDE model."
    use: [SecuritySTRIDE, OWASPTop10]
  }

  append steps {
    SECURITY_VERDICT {
      "Give a security-specific verdict based on findings severity"
    }
  }

  extend warnings [
    "Internal API does not need auth" → "Zero trust principle, always authenticate"
    "We will add security later"      → "Security must be by design"
  ]
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  truthy(fieldOf(ast.body, 'override:steps.ANALYZE'), 'override field');
  truthy(fieldOf(ast.body, 'append:steps'), 'append field');
  const ext = fieldOf(ast.body, 'extend:warnings');
  truthy(ext, 'extend field');
  eq(ext.value.type, 'Array', 'extend value type');
  eq(ext.value.items[0].type, 'Arrow', 'first is arrow');
});

// ── 23. Link shorthand ──────────────────────────────────────────────────────
ok('link shorthand requires/validates_with', () => {
  const src = `
prime Foo extends Method {
  links: [
    requires "owasp-top-10"
    validates_with "security-audit-checklist"
    specializes "base-code-review"
  ]
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const links = fieldOf(ast.body, 'links');
  eq(links.value.items.length, 3, 'three links');
  eq(links.value.items[0].type, 'LinkShorthand', 'first link type');
  eq(links.value.items[0].verb, 'requires', 'first verb');
  eq(links.value.items[0].target, 'owasp-top-10', 'first target');
});

// ── 24. References / dotted paths / aliases ─────────────────────────────────
ok('use references parse correctly', () => {
  const src = `
prime Example extends Method {
  use: [
    OWASPTop10
    TDDRedGreenRefactor.steps
    TDDRedGreenRefactor.steps.RED
    SecuritySTRIDE as secAudit
  ]
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const u = fieldOf(ast.body, 'use');
  eq(u.value.items.length, 4, '4 items');
  eq(u.value.items[0].type, 'Ident', 'first is Ident');
  eq(u.value.items[1].type, 'Reference', 'second is Reference');
  eq(u.value.items[1].path.length, 2, 'second path length');
  eq(u.value.items[3].alias, 'secAudit', 'fourth alias');
});

// ── 25. Arrow expressions ───────────────────────────────────────────────────
ok('Unicode arrow → in array', () => {
  const src = `
prime X extends Method {
  warnings: [
    "Too simple to test" → "Simple code can break in future"
    "Will add tests later" → "Motivation later is near zero"
  ]
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const w = fieldOf(ast.body, 'warnings');
  eq(w.value.items[0].type, 'Arrow', 'arrow');
  eq(w.value.items[0].left.value, 'Too simple to test', 'left');
});
ok('ASCII arrow -> in array', () => {
  const src = `
prime X extends Method {
  branches: [
    "Cannot write test" -> "Refactor to be testable"
  ]
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const b = fieldOf(ast.body, 'branches');
  eq(b.value.items[0].type, 'Arrow', 'arrow');
});

// ── 26. Decorator / EnumValue in field value ────────────────────────────────
ok('@sealed at top-level decorator', () => {
  const { ast, errors } = parse(`
@sealed
prime Foo extends Knowledge {
  name: "foo"
  version: "1.0.0"
}
`);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  eq(ast.decorators.length, 1, '1 decorator');
  eq(ast.decorators[0].name, '@sealed', '@sealed');
});
ok('enum value @decidable in field value', () => {
  const src = `
prime Example extends Method {
  success_criteria: {
    criteria: [
      { id: "test", decidability: @decidable, weight: 0.3 }
    ]
  }
}
`;
  const { ast, errors } = parse(src);
  eq(errors.length, 0, `errors: ${errors.map((e) => e.message).join('; ')}`);
  const sc = fieldOf(ast.body, 'success_criteria');
  const crit = sc.value.fields.find((x) => x.key === 'criteria');
  const first = crit.value.items[0];
  const dec = first.fields.find((x) => x.key === 'decidability');
  eq(dec.value.type, 'EnumValue', 'enum value');
  eq(dec.value.value, '@decidable', '@decidable');
});

// ── 27. Lexer: hyphen identifiers ───────────────────────────────────────────
ok('lexer: hyphen identifiers', () => {
  const tokens = tokenize('owasp-top-10 tdd-red-green').filter((t) => t.type === TokenType.IDENT);
  eq(tokens.length, 2, '2 idents');
  eq(tokens[0].value, 'owasp-top-10', 'first');
});

// ── 28. Lexer: comparison operators ─────────────────────────────────────────
ok('lexer: < > <= >=', () => {
  const tokens = tokenize('< > <= >=').filter(
    (t) => t.type === TokenType.LT || t.type === TokenType.GT || t.type === TokenType.LTE || t.type === TokenType.GTE
  );
  eq(tokens.length, 4, '4 ops');
});

// ── 29. Lexer: percent ──────────────────────────────────────────────────────
ok('lexer: 80%', () => {
  const tokens = tokenize('80%').filter((t) => t.type === TokenType.PERCENT);
  eq(tokens.length, 1, '1 pct');
  eq(tokens[0].value, '80', '80');
});

// ── 30. Lexer: line comments ────────────────────────────────────────────────
ok('lexer: line comment', () => {
  const tokens = tokenize('name // this is a comment\nversion');
  const comments = tokens.filter((t) => t.type === TokenType.COMMENT);
  eq(comments.length, 1, '1 comment');
  eq(comments[0].value, 'this is a comment', 'comment value');
});

// ── 31. Error recovery: missing value ───────────────────────────────────────
ok('error recovery: missing value', () => {
  const src = `prime Example extends Method {
  name: "example"
  version:
  description: "after error"
}`;
  const { ast, errors } = parse(src);
  truthy(errors.length > 0, 'has errors');
  truthy(fieldOf(ast.body, 'description'), 'description recovered');
});

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`);
  process.exit(1);
}
