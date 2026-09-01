/**
 * Tests for kind-form atom declarations.
 *
 * Covers:
 *   - Every legacy v1 kind produces an AtomDeclaration with the correct .kind
 *     WITHOUT the lexer or parser holding a list of kinds
 *   - A kind the engine has never heard of parses exactly the same way
 *   - Body fields parse correctly (string, number, array, object)
 *   - @-prefixed strings (cross-atom references) parse as plain StringNode
 *   - Legacy `prime … extends …` syntax is still backwards-compatible
 */

import { describe, test, expect } from "bun:test";
import { parse, TokenType, tokenize } from "../src/index";
import type {
  AtomDeclaration,
  PrimeAST,
  FieldNode,
  StringNode,
  NumberNode,
  IdentNode,
  ArrayNode,
  ObjectNode,
} from "@aoe/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function field(body: FieldNode[], key: string): FieldNode | undefined {
  return body.find((f) => f.key === key);
}

function asAtom(src: string): AtomDeclaration {
  const { ast, errors } = parse(src);
  if (errors.length > 0) {
    throw new Error(`Unexpected parse errors: ${errors.map((e) => e.message).join("; ")}`);
  }
  if (ast.type !== "AtomDeclaration") {
    throw new Error(`Expected AtomDeclaration, got ${ast.type}`);
  }
  return ast as AtomDeclaration;
}

// ─── 1. Every v1 kind parses via the generic production ──────────────────────

describe("kind-form declarations — basic shape", () => {
  // Minimal fixture for every legacy v1 kind: `<kind> Demo { label: "ok" }`.
  // Hyphenated kinds work because the lexer reads hyphens as part of an IDENT.
  const ALL_28: Array<[string, string]> = [
    // Data / Value (8)
    ["fact",            "fact Demo { label: \"ok\" }"],
    ["term",            "term Demo { label: \"ok\" }"],
    ["value",           "value Demo { label: \"ok\" }"],
    ["category",        "category Demo { label: \"ok\" }"],
    ["example",         "example Demo { label: \"ok\" }"],
    ["counter-example", "counter-example Demo { label: \"ok\" }"],
    ["source",          "source Demo { label: \"ok\" }"],
    ["metric",          "metric Demo { label: \"ok\" }"],
    // Behaviour (4)
    ["step",      "step Demo { label: \"ok\" }"],
    ["check",     "check Demo { label: \"ok\" }"],
    ["transform", "transform Demo { label: \"ok\" }"],
    ["tool",      "tool Demo { label: \"ok\" }"],
    // Composition (6)
    ["method",      "method Demo { label: \"ok\" }"],
    ["rule",        "rule Demo { label: \"ok\" }"],
    ["taxonomy",    "taxonomy Demo { label: \"ok\" }"],
    ["pattern",     "pattern Demo { label: \"ok\" }"],
    ["anti-pattern","anti-pattern Demo { label: \"ok\" }"],
    ["type",        "type Demo { label: \"ok\" }"],
    // Style / Parameter (5)
    ["persona",     "persona Demo { label: \"ok\" }"],
    ["voice",       "voice Demo { label: \"ok\" }"],
    ["constraint",  "constraint Demo { label: \"ok\" }"],
    ["template",    "template Demo { label: \"ok\" }"],
    ["provocation", "provocation Demo { label: \"ok\" }"],
    // Meta / Binding (5)
    ["collection", "collection Demo { label: \"ok\" }"],
    ["scope",      "scope Demo { label: \"ok\" }"],
    ["tradeoff",   "tradeoff Demo { label: \"ok\" }"],
    ["principle",  "principle Demo { label: \"ok\" }"],
    ["feedback",   "feedback Demo { label: \"ok\" }"],
  ];

  // The engine no longer owns a kind list, so the meaningful assertion is not
  // "there are 28" but "the count does not matter": a kind nobody declared in
  // Core parses exactly like a legacy one. This is the ADR-1 architecture proof
  // at the grammar level.
  const NEVER_SEEN_BY_CORE: Array<[string, string]> = [
    ["Widget",        `Widget Demo { label: "ok" }`],
    ["Ticket",        `Ticket Demo { label: "ok" }`],
    ["Owner",         `Owner Demo { label: "ok" }`],
    ["service-mesh",  `service-mesh Demo { label: "ok" }`],
    ["knowledge",     `knowledge Demo { label: "ok" }`],
  ];

  for (const [kind, src] of [...ALL_28, ...NEVER_SEEN_BY_CORE]) {
    test(`${kind} → AtomDeclaration with kind="${kind}"`, () => {
      const atom = asAtom(src);
      expect(atom.type).toBe("AtomDeclaration");
      expect(atom.kind).toBe(kind);
      expect(atom.name).toBe("Demo");
    });
  }
});

// ─── 2. Sample fixtures from the task spec ───────────────────────────────────

describe("fact — full body", () => {
  const src = `
fact WcagFocusContrast {
  statement: "Focus ring contrast must be ≥ 3:1 against adjacent colors"
  confidence: proven
  evidence: "@w3c/wcag-2-4-11"
}
`;

  test("parses without errors", () => {
    const { errors } = parse(src);
    expect(errors).toHaveLength(0);
  });

  test("has correct kind and name", () => {
    const atom = asAtom(src);
    expect(atom.kind).toBe("fact");
    expect(atom.name).toBe("WcagFocusContrast");
  });

  test("string field: statement", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "statement");
    expect(f).toBeDefined();
    expect(f!.value.type).toBe("String");
    expect((f!.value as StringNode).value).toContain("Focus ring");
  });

  test("ident field: confidence", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "confidence");
    expect(f).toBeDefined();
    expect(f!.value.type).toBe("Ident");
    expect((f!.value as IdentNode).value).toBe("proven");
  });

  test("cross-atom @-reference parses as plain string", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "evidence");
    expect(f).toBeDefined();
    expect(f!.value.type).toBe("String");
    expect((f!.value as StringNode).value).toBe("@w3c/wcag-2-4-11");
  });
});

test("a declaration keyword remains legal corpus data inside an array", () => {
  const atom = asAtom('principle TestPyramid { tags: [testing, unit, integration] }');
  const tags = field(atom.body, "tags")?.value;
  expect(tags?.type).toBe("Array");
  if (tags?.type === "Array") expect(tags.items.map(item => "value" in item ? item.value : undefined)).toEqual(["testing", "unit", "integration"]);
});

describe("step — signature + effect + errors + body", () => {
  const src = `
step LoadArtifact {
  signature: "(artifact: URL) -> Document"
  effect: "read-only"
  errors: ["LoadTimeout", "NotFound"]
  body: "Read the artifact at the given URL. Wait up to 30s."
}
`;

  test("parses without errors", () => {
    const { errors } = parse(src);
    expect(errors).toHaveLength(0);
  });

  test("has kind=step", () => {
    expect(asAtom(src).kind).toBe("step");
  });

  test("errors array has two string items", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "errors");
    expect(f!.value.type).toBe("Array");
    const arr = f!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);
    expect((arr.items[0] as StringNode).value).toBe("LoadTimeout");
    expect((arr.items[1] as StringNode).value).toBe("NotFound");
  });
});

describe("method — input/output/uses/body", () => {
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

  test("parses without errors", () => {
    const { errors } = parse(src);
    expect(errors).toHaveLength(0);
  });

  test("kind is method", () => {
    expect(asAtom(src).kind).toBe("method");
  });

  test("input is an object with two fields", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "input");
    expect(f!.value.type).toBe("Object");
    const obj = f!.value as ObjectNode;
    expect(obj.fields.length).toBe(2);
  });

  test("uses is an array of @-prefixed strings", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "uses");
    expect(f!.value.type).toBe("Array");
    const arr = f!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);
    expect((arr.items[0] as StringNode).value).toBe("@step/load-artifact");
  });

  test("body is an array with two strings", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "body");
    expect(f!.value.type).toBe("Array");
    const arr = f!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);
  });
});

describe("taxonomy — members + source", () => {
  const src = `
taxonomy NielsenHeuristics {
  members: [
    "@fact/visibility-of-system-status"
    "@fact/match-system-real-world"
  ]
  source: "@source/nielsen-1994"
}
`;

  test("parses without errors", () => {
    const { errors } = parse(src);
    expect(errors).toHaveLength(0);
  });

  test("kind is taxonomy", () => {
    expect(asAtom(src).kind).toBe("taxonomy");
  });

  test("members array has two items", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "members");
    const arr = f!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);
    expect((arr.items[0] as StringNode).value).toBe("@fact/visibility-of-system-status");
  });
});

describe("collection — full spec fixture", () => {
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

  test("parses without errors", () => {
    const { errors } = parse(src);
    expect(errors).toHaveLength(0);
  });

  test("kind is collection", () => {
    expect(asAtom(src).kind).toBe("collection");
  });

  test("description is a string", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "description");
    expect(f!.value.type).toBe("String");
  });

  test("includes array has three @-prefixed strings", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "includes");
    const arr = f!.value as ArrayNode;
    expect(arr.items).toHaveLength(3);
    expect((arr.items[0] as StringNode).value).toContain("@rule");
    expect((arr.items[2] as StringNode).value).toContain("@taxonomy");
  });

  test("target is a plain ident", () => {
    const atom = asAtom(src);
    const f = field(atom.body, "target");
    expect(f!.value.type).toBe("Ident");
    expect((f!.value as IdentNode).value).toBe("claude-code");
  });
});

// ─── 3. Other notable kinds ───────────────────────────────────────────────────

describe("principle", () => {
  const src = `
principle ClarityOverCleverness {
  statement: "When choosing between a clear solution and a clever one, pick clear."
  domain: software-engineering
}
`;
  test("parses without errors and kind=principle", () => {
    const atom = asAtom(src);
    expect(atom.kind).toBe("principle");
    expect(atom.name).toBe("ClarityOverCleverness");
  });
});

describe("tradeoff", () => {
  const src = `
tradeoff DenseVsComfortable {
  axes: ["density", "users-expert"]
  examples: ["@example/bloomberg", "@example/notion"]
}
`;
  test("parses without errors and kind=tradeoff", () => {
    const atom = asAtom(src);
    expect(atom.kind).toBe("tradeoff");
    expect(atom.name).toBe("DenseVsComfortable");
    const f = field(atom.body, "axes");
    expect(f!.value.type).toBe("Array");
  });
});

describe("constraint", () => {
  const src = `
constraint FontBlacklist {
  target: font-family
  severity: block
  remediation: "@whitelist/display-serif-fonts"
}
`;
  test("parses without errors and kind=constraint", () => {
    const atom = asAtom(src);
    expect(atom.kind).toBe("constraint");
  });
});

describe("anti-pattern (hyphenated keyword)", () => {
  const src = `
anti-pattern LinearClone {
  description: "Dark background + purple accent + Inter = AI-slop aesthetic"
  detection: "@check/slop-detector"
}
`;
  test("parses without errors and kind=anti-pattern", () => {
    const atom = asAtom(src);
    expect(atom.kind).toBe("anti-pattern");
    expect(atom.name).toBe("LinearClone");
  });
});

describe("counter-example (hyphenated keyword)", () => {
  const src = `
counter-example InterFontOveruse {
  description: "Linear-clone dark+purple+Inter combination"
  domain: typography
}
`;
  test("parses without errors and kind=counter-example", () => {
    const atom = asAtom(src);
    expect(atom.kind).toBe("counter-example");
    expect(atom.name).toBe("InterFontOveruse");
  });
});

describe("type (reserved word used as atom kind)", () => {
  const src = `
type HtmlArtifact {
  fields: { url: "string", title: "string" }
}
`;
  test("parses without errors and kind=type", () => {
    const atom = asAtom(src);
    expect(atom.kind).toBe("type");
    expect(atom.name).toBe("HtmlArtifact");
  });
});

describe("feedback", () => {
  const src = `
feedback DesignCritiqueExecution {
  success_rate: 0.87
  runs: 42
  notes: "mostly passes in deep mode"
}
`;
  test("parses without errors and kind=feedback", () => {
    const atom = asAtom(src);
    expect(atom.kind).toBe("feedback");
    const f = field(atom.body, "success_rate");
    expect(f!.value.type).toBe("Number");
    expect((f!.value as NumberNode).value).toBe(0.87);
  });
});

describe("scope", () => {
  const src = `
scope NodeEnvironment {
  requires: ["node >= 20", "bun >= 1.0", "git clean"]
  platform: linux
}
`;
  test("parses without errors and kind=scope", () => {
    const atom = asAtom(src);
    expect(atom.kind).toBe("scope");
  });
});

// ─── 4. Decorators on atom declarations ─────────────────────────────────────

describe("decorators on atom declarations", () => {
  const src = `
@sealed
fact SealedFact {
  statement: "immutable fact"
}
`;
  test("decorator is captured", () => {
    const atom = asAtom(src);
    expect(atom.decorators).toHaveLength(1);
    expect(atom.decorators[0].name).toBe("@sealed");
  });
});

// ─── 5. Backwards compatibility — legacy `prime` syntax ─────────────────────

describe("Backwards compatibility: legacy prime syntax", () => {
  test("prime X extends Knowledge { } still produces PrimeDeclaration", () => {
    const src = `
prime OWASPTop10 extends Knowledge {
  name: "owasp-top-10"
  version: "1.0.0"
}
`;
    const { ast, errors } = parse(src);
    expect(errors).toHaveLength(0);
    expect(ast.type).toBe("PrimeDeclaration");
    const primeAst = ast as PrimeAST;
    expect(primeAst.name).toBe("OWASPTop10");
    expect(primeAst.extends).toBe("Knowledge");
  });

  test("prime without extends still works", () => {
    const src = `prime Standalone { name: "x" version: "1.0.0" }`;
    const { ast, errors } = parse(src);
    expect(errors).toHaveLength(0);
    expect(ast.type).toBe("PrimeDeclaration");
  });
});

// ─── 6. Cross-atom references (@scope/path) parse as plain strings ───────────

describe("@scope/path references in field values", () => {
  test("@-prefixed string in scalar field", () => {
    const src = `
method Foo {
  uses: "@step/load"
}
`;
    const atom = asAtom(src);
    const f = field(atom.body, "uses");
    expect(f!.value.type).toBe("String");
    expect((f!.value as StringNode).value).toBe("@step/load");
  });

  test("@-prefixed strings in array field", () => {
    const src = `
collection Foo {
  includes: ["@rule/x", "@method/y", "@taxonomy/z"]
}
`;
    const atom = asAtom(src);
    const f = field(atom.body, "includes");
    const arr = f!.value as ArrayNode;
    expect(arr.items).toHaveLength(3);
    for (const item of arr.items) {
      expect(item.type).toBe("String");
      expect((item as StringNode).value.startsWith("@")).toBe(true);
    }
  });
});

// ─── 7. Atom-kind keywords work as field names inside bodies ─────────────────

describe("Atom-kind keywords usable as field names inside bodies", () => {
  test("'method', 'rule', 'type' can be field keys", () => {
    const src = `
fact Foo {
  method: "some description"
  rule: "another"
  type: "html-artifact"
}
`;
    const atom = asAtom(src);
    expect(field(atom.body, "method")).toBeDefined();
    expect(field(atom.body, "rule")).toBeDefined();
    expect(field(atom.body, "type")).toBeDefined();
  });
});

// ─── 8. Lexer knows NO atom kind ─────────────────────────────────────────────

describe("Lexer: kind names are ordinary identifiers", () => {
  const v1Kinds = [
    "fact", "term", "value", "category", "example", "counter-example", "source", "metric",
    "step", "check", "transform", "tool",
    "method", "rule", "taxonomy", "pattern", "anti-pattern", "type",
    "persona", "voice", "constraint", "template", "provocation",
    "collection", "scope", "tradeoff", "principle", "feedback",
  ] as const;

  test("every v1 kind name lexes as a plain IDENT, not a keyword", () => {
    for (const word of v1Kinds) {
      const tokens = tokenize(word).filter((t) => t.type !== TokenType.EOF && t.type !== TokenType.NEWLINE);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe(TokenType.IDENT);
      expect(tokens[0].value).toBe(word);
    }
  });

  test("TokenType exposes no atom-kind members", () => {
    // If a kind ever becomes a token again, the engine has taken the domain
    // ontology back and ADR-1 is broken. Guard it by name.
    const members = Object.keys(TokenType);
    for (const word of v1Kinds) {
      const asMember = word.toUpperCase().replace(/-/g, "_");
      expect(members).not.toContain(asMember);
    }
  });

  test("structural keywords are still keywords", () => {
    const structural: Array<[string, TokenType]> = [
      ["prime", TokenType.PRIME],
      ["unit", TokenType.UNIT],
      ["extends", TokenType.EXTENDS],
      ["override", TokenType.OVERRIDE],
      ["append", TokenType.APPEND],
      ["extend", TokenType.EXTEND],
      ["as", TokenType.AS],
    ];
    for (const [word, expected] of structural) {
      const tokens = tokenize(word).filter((t) => t.type !== TokenType.EOF && t.type !== TokenType.NEWLINE);
      expect(tokens[0]!.type).toBe(expected);
    }
  });
});

// ─── 9. Empty body ───────────────────────────────────────────────────────────

describe("Atom with empty body", () => {
  test("parses empty body without errors", () => {
    const src = `principle Empty {}`;
    const atom = asAtom(src);
    expect(atom.body).toHaveLength(0);
  });
});

// ─── 10. Filename is set on AtomDeclaration ──────────────────────────────────

describe("Filename tracking", () => {
  test("filename is set when provided", () => {
    const { ast } = parse(`fact Foo { label: "ok" }`, "foo.prime");
    expect(ast.type).toBe("AtomDeclaration");
    expect((ast as AtomDeclaration).filename).toBe("foo.prime");
  });
});
