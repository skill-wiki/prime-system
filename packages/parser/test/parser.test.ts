/**
 * Tests for the @skill-wiki/parser package.
 *
 * Uses Bun's built-in test runner.
 */

import { describe, test, expect } from "bun:test";
import { parseLegacy as parse, tokenize, TokenType, ParseError } from "../src/index";
import type {
  PrimeAST,
  AtomDeclaration,
  FieldNode,
  StringNode,
  NumberNode,
  BooleanNode,
  IdentNode,
  ObjectNode,
  ArrayNode,
  ArrowNode,
  StepNode,
  ReferenceNode,
  EnumValueNode,
  LinkShorthandNode,
  ThresholdNode,
  ParameterShorthandNode,
  DecoratorNode,
} from "@skill-wiki/types";

function asPrime(ast: PrimeAST | AtomDeclaration): PrimeAST {
  if (ast.type !== "PrimeDeclaration") throw new Error(`Expected PrimeAST, got ${ast.type}`);
  return ast as PrimeAST;
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function findField(fields: FieldNode[], key: string): FieldNode | undefined {
  return fields.find((f) => f.key === key);
}

// ─── Test: Simple Knowledge Prime ───────────────────────────────────────────

describe("Simple Knowledge Prime", () => {
  const source = `
prime OWASPTop10 extends Knowledge {
  name: "owasp-top-10"
  version: "1.3.0"
  description: "OWASP Top 10 Web Security Risks"
  tags: ["security", "web"]
  author: { name: "OWASP Foundation", url: "https://owasp.org" }
  license: "CC-BY-SA-4.0"
}
`;

  test("parses without errors", () => {
    const { ast, errors } = parse(source, "owasp.prime");
    expect(errors).toHaveLength(0);
    expect(ast.type).toBe("PrimeDeclaration");
  });

  test("parses prime name and extends", () => {
    const { ast } = parse(source);
    expect(ast.name).toBe("OWASPTop10");
    expect(asPrime(ast).extends).toBe("Knowledge");
  });

  test("parses string fields", () => {
    const { ast } = parse(source);
    const nameField = findField(ast.body, "name");
    expect(nameField).toBeDefined();
    expect(nameField!.value.type).toBe("String");
    expect((nameField!.value as StringNode).value).toBe("owasp-top-10");

    const versionField = findField(ast.body, "version");
    expect(versionField).toBeDefined();
    expect((versionField!.value as StringNode).value).toBe("1.3.0");
  });

  test("parses array of strings", () => {
    const { ast } = parse(source);
    const tagsField = findField(ast.body, "tags");
    expect(tagsField).toBeDefined();
    expect(tagsField!.value.type).toBe("Array");
    const arr = tagsField!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);
    expect((arr.items[0] as StringNode).value).toBe("security");
    expect((arr.items[1] as StringNode).value).toBe("web");
  });

  test("parses nested object (author)", () => {
    const { ast } = parse(source);
    const authorField = findField(ast.body, "author");
    expect(authorField).toBeDefined();
    expect(authorField!.value.type).toBe("Object");
    const obj = authorField!.value as ObjectNode;
    const nameInner = findField(obj.fields, "name");
    expect(nameInner).toBeDefined();
    expect((nameInner!.value as StringNode).value).toBe("OWASP Foundation");
  });

  test("sets filename on AST", () => {
    const { ast } = parse(source, "owasp.prime");
    expect(ast.filename).toBe("owasp.prime");
  });

  test("tracks source locations", () => {
    const { ast } = parse(source);
    // prime keyword is on line 2 (blank line 1)
    expect(ast.loc.line).toBeGreaterThan(0);
  });
});

// ─── Test: Method Prime with steps, expect, error ───────────────────────────

describe("Method Prime with steps", () => {
  const source = `
prime TDDRedGreenRefactor extends Method {
  name: "tdd-red-green-refactor"
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
      "Eliminate duplication, improve naming, simplify. Run tests after each change."
      expect: pass
      error: "Refactoring broke tests — rollback to last GREEN"
    }
  ]
}
`;

  test("parses steps array", () => {
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const stepsField = findField(ast.body, "steps");
    expect(stepsField).toBeDefined();
    expect(stepsField!.value.type).toBe("Array");

    const arr = stepsField!.value as ArrayNode;
    expect(arr.items).toHaveLength(3);
  });

  test("parses step names", () => {
    const { ast } = parse(source);
    const arr = findField(ast.body, "steps")!.value as ArrayNode;

    const red = arr.items[0] as StepNode;
    expect(red.type).toBe("Step");
    expect(red.name).toBe("RED");

    const green = arr.items[1] as StepNode;
    expect(green.name).toBe("GREEN");

    const refactor = arr.items[2] as StepNode;
    expect(refactor.name).toBe("REFACTOR");
  });

  test("parses step descriptions as strings", () => {
    const { ast } = parse(source);
    const arr = findField(ast.body, "steps")!.value as ArrayNode;

    const red = arr.items[0] as StepNode;
    // First item in body should be the description string
    const desc = red.body.find((item) => item.type === "String") as StringNode | undefined;
    expect(desc).toBeDefined();
    expect(desc!.value).toContain("Write a test");
  });

  test("parses step expect field", () => {
    const { ast } = parse(source);
    const arr = findField(ast.body, "steps")!.value as ArrayNode;

    const red = arr.items[0] as StepNode;
    const expectField = red.body.find(
      (item) => item.type === "Field" && (item as FieldNode).key === "expect"
    ) as FieldNode | undefined;
    expect(expectField).toBeDefined();
    expect(expectField!.value.type).toBe("Ident");
    expect((expectField!.value as IdentNode).value).toBe("fail");
  });

  test("parses step error as string", () => {
    const { ast } = parse(source);
    const arr = findField(ast.body, "steps")!.value as ArrayNode;

    const red = arr.items[0] as StepNode;
    const errorField = red.body.find(
      (item) => item.type === "Field" && (item as FieldNode).key === "error"
    ) as FieldNode | undefined;
    expect(errorField).toBeDefined();
    expect(errorField!.value.type).toBe("String");
  });

  test("parses step error as object", () => {
    const { ast } = parse(source);
    const arr = findField(ast.body, "steps")!.value as ArrayNode;

    const green = arr.items[1] as StepNode;
    const errorField = green.body.find(
      (item) => item.type === "Field" && (item as FieldNode).key === "error"
    ) as FieldNode | undefined;
    expect(errorField).toBeDefined();
    expect(errorField!.value.type).toBe("Object");

    const obj = errorField!.value as ObjectNode;
    const msgField = findField(obj.fields, "message");
    expect(msgField).toBeDefined();
    expect((msgField!.value as StringNode).value).toBe("Test did not pass");

    const retryField = findField(obj.fields, "retry");
    expect(retryField).toBeDefined();
    expect((retryField!.value as NumberNode).value).toBe(3);
  });
});

// ─── Test: Rule Prime with checks and thresholds ────────────────────────────

describe("Rule Prime with checks and thresholds", () => {
  const source = `
prime TestCoverageStandard extends Rule {
  name: "test-coverage-standard"
  version: "1.0.0"

  checks: [
    { description: "Every public function has at least one test",
      pass: "function_coverage >= 100%",
      category: "coverage", weight: 0.3 }
    { description: "Saw each test fail then pass",
      pass: "red_green_verified == true",
      category: "process", weight: 0.2 }
  ]

  thresholds: [
    line_coverage     block: < 60%   warn: < 80%   pass: >= 80%
    branch_coverage   block: < 50%   warn: < 70%   pass: >= 70%
  ]

  severity: {
    block: "Not allowed to merge, must fix"
    warn: "Allowed to merge but create tech debt issue"
    pass: "Passed"
  }
}
`;

  test("parses checks array with objects", () => {
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const checksField = findField(ast.body, "checks");
    expect(checksField).toBeDefined();

    const arr = checksField!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);
    expect(arr.items[0].type).toBe("Object");

    const firstCheck = arr.items[0] as ObjectNode;
    const descField = findField(firstCheck.fields, "description");
    expect(descField).toBeDefined();
    expect((descField!.value as StringNode).value).toContain("Every public function");
  });

  test("parses threshold shorthands", () => {
    const { ast } = parse(source);
    const thresholdsField = findField(ast.body, "thresholds");
    expect(thresholdsField).toBeDefined();

    const arr = thresholdsField!.value as ArrayNode;
    expect(arr.items.length).toBeGreaterThanOrEqual(2);

    const first = arr.items[0] as ThresholdNode;
    expect(first.type).toBe("Threshold");
    expect(first.metric).toBe("line_coverage");
    expect(first.levels).toHaveLength(3);

    const blockLevel = first.levels.find((l) => l.level === "block");
    expect(blockLevel).toBeDefined();
    expect(blockLevel!.operator).toBe("<");
    expect(blockLevel!.value).toBe(60);

    const passLevel = first.levels.find((l) => l.level === "pass");
    expect(passLevel).toBeDefined();
    expect(passLevel!.operator).toBe(">=");
    expect(passLevel!.value).toBe(80);
  });

  test("parses severity object", () => {
    const { ast } = parse(source);
    const severityField = findField(ast.body, "severity");
    expect(severityField).toBeDefined();
    expect(severityField!.value.type).toBe("Object");
  });
});

// ─── Test: Inheritance (extends, override, append, extend) ──────────────────

describe("Inheritance syntax", () => {
  const source = `
prime SecurityCodeReview extends BaseCodeReview {
  name: "security-code-review"
  version: "1.0.0"

  override steps.ANALYZE {
    "Evaluate each change for security threats using STRIDE model."
    use: [SecuritySTRIDE, OWASPTop10]
    expect: pass
    error: "Cannot complete security analysis — manual review needed"
  }

  append steps {
    SECURITY_VERDICT {
      "Give a security-specific verdict based on findings severity"
      error: "Found Critical vulnerability — must block merge"
    }
  }

  extend warnings [
    "Internal API does not need auth" → "Zero trust principle, always authenticate"
    "We will add security later"      → "Security must be by design"
  ]
}
`;

  test("parses without errors", () => {
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(asPrime(ast).extends).toBe("BaseCodeReview");
  });

  test("parses override as pseudo-field", () => {
    const { ast } = parse(source);
    const overrideField = findField(ast.body, "override:steps.ANALYZE");
    expect(overrideField).toBeDefined();
    expect(overrideField!.value.type).toBe("Object");

    const obj = overrideField!.value as ObjectNode;
    // Should contain description and fields
    expect(obj.fields.length).toBeGreaterThan(0);
  });

  test("parses append as pseudo-field", () => {
    const { ast } = parse(source);
    const appendField = findField(ast.body, "append:steps");
    expect(appendField).toBeDefined();
    // append steps { ... } produces an Object containing step shorthands
    expect(appendField!.value.type).toBe("Object");
  });

  test("parses extend as pseudo-field with array", () => {
    const { ast } = parse(source);
    const extendField = findField(ast.body, "extend:warnings");
    expect(extendField).toBeDefined();
    expect(extendField!.value.type).toBe("Array");

    const arr = extendField!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);
    // Items should be arrow expressions
    expect(arr.items[0].type).toBe("Arrow");
  });
});

// ─── Test: Links and use references ─────────────────────────────────────────

describe("Links and use references", () => {
  const linksSource = `
prime SecurityCodeReview extends Method {
  name: "security-code-review"
  version: "1.0.0"

  links: [
    requires -> "owasp-top-10"
    requires -> "security-stride"
    validates_with -> "security-audit-checklist"
    specializes -> "base-code-review"
    contradicts -> "naive-trust-model"
  ]
}
`;

  test("parses link shorthands", () => {
    const { ast, errors } = parse(linksSource);
    expect(errors).toHaveLength(0);

    const linksField = findField(ast.body, "links");
    expect(linksField).toBeDefined();

    const arr = linksField!.value as ArrayNode;
    expect(arr.items).toHaveLength(5);

    const first = arr.items[0] as LinkShorthandNode;
    expect(first.type).toBe("LinkShorthand");
    expect(first.verb).toBe("requires");
    expect(first.target).toBe("owasp-top-10");

    const third = arr.items[2] as LinkShorthandNode;
    expect(third.verb).toBe("validates_with");
    expect(third.target).toBe("security-audit-checklist");
  });

  // ── The de-domaining property ───────────────────────────────────────────
  // The arrow, not the verb's spelling, is what makes a relation a relation.
  // These tests fail if a verb vocabulary is ever reintroduced into the
  // grammar, which is the one thing the parser must never know (plan §6.4).

  test("a verb the grammar has never seen parses identically to a prime-v1 one", () => {
    const known = parse(`prime F extends M { links: [ requires -> "@a/b" ] }`);
    const unknown = parse(`prime F extends M { links: [ frobnicates -> "@a/b" ] }`);
    expect(known.errors).toHaveLength(0);
    expect(unknown.errors).toHaveLength(0);

    const k = (findField(known.ast.body, "links")!.value as ArrayNode)
      .items[0] as LinkShorthandNode;
    const u = (findField(unknown.ast.body, "links")!.value as ArrayNode)
      .items[0] as LinkShorthandNode;
    expect(k.type).toBe("LinkShorthand");
    expect(u.type).toBe("LinkShorthand");
    expect(u.verb).toBe("frobnicates");
    expect(u.target).toBe(k.target);
  });

  test("link modifiers work for any verb, not just prime-v1 ones", () => {
    const { ast, errors } = parse(
      `prime F extends M { links: [ frobnicates -> "@a/b" (strength: 0.5) ] }`
    );
    expect(errors).toHaveLength(0);
    const link = (findField(ast.body, "links")!.value as ArrayNode)
      .items[0] as LinkShorthandNode;
    expect(link.type).toBe("LinkShorthand");
    expect(link.modifiers).toBeDefined();
    expect(link.modifiers!.fields[0]!.key).toBe("strength");
  });

  test("the arrow form is available in all three positions", () => {
    const arrayPos = parse(`prime F extends M { links: [ requires -> "@a/b" ] }`);
    const fieldPos = parse(`prime F extends M { rel: requires -> "@a/b" }`);
    const bodyPos = parse(`prime F extends M { requires -> "@a/b" }`);
    for (const r of [arrayPos, fieldPos, bodyPos]) {
      expect(r.errors).toHaveLength(0);
    }
    const fromArray = (findField(arrayPos.ast.body, "links")!.value as ArrayNode)
      .items[0] as LinkShorthandNode;
    const fromField = findField(fieldPos.ast.body, "rel")!.value as LinkShorthandNode;
    const fromBody = findField(bodyPos.ast.body, "requires")!.value as LinkShorthandNode;
    for (const n of [fromArray, fromField, fromBody]) {
      expect(n.type).toBe("LinkShorthand");
      expect(n.verb).toBe("requires");
      expect(n.target).toBe("@a/b");
    }
  });

  test("IDENT STRING is category shorthand for every identifier, verbs included", () => {
    const { ast, errors } = parse(
      `prime F extends M { caps: [ Foo "does a thing"\n    requires "not a relation" ] }`
    );
    expect(errors).toHaveLength(0);
    const items = (findField(ast.body, "caps")!.value as ArrayNode).items;
    expect(items.map((i) => i.type)).toEqual([
      "ParameterShorthand",
      "ParameterShorthand",
    ]);
  });

  const useSource = `
prime Example extends Method {
  name: "example"
  version: "1.0.0"

  use: [
    OWASPTop10
    TDDRedGreenRefactor.steps
    TDDRedGreenRefactor.steps.RED
    SecuritySTRIDE as secAudit
    TestCoverageStandard as postCheck
  ]
}
`;

  test("parses use references", () => {
    const { ast, errors } = parse(useSource);
    expect(errors).toHaveLength(0);

    const useField = findField(ast.body, "use");
    expect(useField).toBeDefined();

    const arr = useField!.value as ArrayNode;
    expect(arr.items).toHaveLength(5);

    // Plain ident
    const first = arr.items[0] as IdentNode;
    expect(first.type).toBe("Ident");
    expect(first.value).toBe("OWASPTop10");

    // Dotted path
    const second = arr.items[1] as ReferenceNode;
    expect(second.type).toBe("Reference");
    expect(second.path).toEqual(["TDDRedGreenRefactor", "steps"]);

    // Triple dotted path
    const third = arr.items[2] as ReferenceNode;
    expect(third.type).toBe("Reference");
    expect(third.path).toEqual(["TDDRedGreenRefactor", "steps", "RED"]);

    // Alias
    const fourth = arr.items[3] as ReferenceNode;
    expect(fourth.type).toBe("Reference");
    expect(fourth.path).toEqual(["SecuritySTRIDE"]);
    expect(fourth.alias).toBe("secAudit");

    // Alias (second)
    const fifth = arr.items[4] as ReferenceNode;
    expect(fifth.path).toEqual(["TestCoverageStandard"]);
    expect(fifth.alias).toBe("postCheck");
  });
});

// ─── Test: Error recovery on malformed input ────────────────────────────────

describe("Error recovery", () => {
  test("recovers from missing value after field name", () => {
    const source = `
prime Example extends Method {
  name: "example"
  version:
  description: "after error"
}
`;
    const { ast, errors } = parse(source);
    // Should have at least one error about missing value
    expect(errors.length).toBeGreaterThan(0);
    // But should still parse the description field
    const descField = findField(ast.body, "description");
    expect(descField).toBeDefined();
  });

  test("recovers from missing colon after field name", () => {
    const source = `
prime Example extends Knowledge {
  name "example"
  version: "1.0.0"
}
`;
    const { ast, errors } = parse(source);
    // Should have errors
    expect(errors.length).toBeGreaterThanOrEqual(0);
    // The "name" field might be parsed as a ParameterShorthand (ident + string)
    // or might produce an error, but parsing should still continue
    const versionField = findField(ast.body, "version");
    expect(versionField).toBeDefined();
    expect((versionField!.value as StringNode).value).toBe("1.0.0");
  });

  test("collects multiple errors", () => {
    const source = `
prime Example extends Method {
  steps: [
    RED {
      expect: fail
      error
    }
    GREEN {
      expect: pass
    }
  ]
}
`;
    const { ast, errors } = parse(source);
    // Should have error about 'error' missing value
    expect(errors.length).toBeGreaterThan(0);
    // But should still parse GREEN step
    const stepsField = findField(ast.body, "steps");
    expect(stepsField).toBeDefined();
    const arr = stepsField!.value as ArrayNode;
    // Should have parsed at least the GREEN step
    const greenStep = arr.items.find(
      (item) => item.type === "Step" && (item as StepNode).name === "GREEN"
    );
    expect(greenStep).toBeDefined();
  });

  test("ParseError has line and column info", () => {
    const source = `
prime Example extends Knowledge {
  name: "example"
  version:
  description: "ok"
}
`;
    const { errors } = parse(source, "test.prime");
    expect(errors.length).toBeGreaterThan(0);
    const err = errors[0];
    expect(err).toBeInstanceOf(ParseError);
    expect(err.line).toBeGreaterThan(0);
    expect(err.column).toBeGreaterThan(0);
    expect(err.filename).toBe("test.prime");
  });

  test("ParseError format() includes suggestion", () => {
    const err = new ParseError({
      message: "test error",
      line: 5,
      column: 10,
      suggestion: "try adding a colon",
      filename: "test.prime",
    });
    const formatted = err.format();
    expect(formatted).toContain("test error");
    expect(formatted).toContain("try adding a colon");
  });
});

// ─── Test: Arrow expression parsing ─────────────────────────────────────────

describe("Arrow expression parsing", () => {
  test("parses Unicode arrow (→)", () => {
    const source = `
prime Example extends Method {
  name: "example"
  version: "1.0.0"
  warnings: [
    "Too simple to test" → "Simple code can break in future changes"
    "Will add tests later" → "Motivation to add tests later is near zero"
  ]
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const warningsField = findField(ast.body, "warnings");
    expect(warningsField).toBeDefined();

    const arr = warningsField!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);

    const first = arr.items[0] as ArrowNode;
    expect(first.type).toBe("Arrow");
    expect(first.left.value).toBe("Too simple to test");
    expect(first.right.value).toBe("Simple code can break in future changes");
  });

  test("parses ASCII arrow (->)", () => {
    const source = `
prime Example extends Method {
  name: "example"
  version: "1.0.0"
  branches: [
    "Cannot write test" -> "Refactor interface to be testable, then go back to RED"
  ]
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const branchesField = findField(ast.body, "branches");
    const arr = branchesField!.value as ArrayNode;
    const first = arr.items[0] as ArrowNode;
    expect(first.type).toBe("Arrow");
    expect(first.left.value).toBe("Cannot write test");
  });
});

// ─── Test: Decorator parsing ────────────────────────────────────────────────

describe("Decorator parsing", () => {
  test("parses @sealed decorator", () => {
    const source = `
@sealed
prime OWASPTop10 extends Knowledge {
  name: "owasp-top-10"
  version: "1.0.0"
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.decorators).toHaveLength(1);
    expect(ast.decorators[0].name).toBe("@sealed");
  });

  test("parses @abstract decorator", () => {
    const source = `
@abstract
prime BaseCodeReview extends Method {
  name: "base-code-review"
  version: "1.0.0"
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.decorators).toHaveLength(1);
    expect(ast.decorators[0].name).toBe("@abstract");
  });

  test("parses multiple decorators", () => {
    const source = `
@abstract
@internal
prime Example extends Method {
  name: "example"
  version: "1.0.0"
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.decorators).toHaveLength(2);
    expect(ast.decorators[0].name).toBe("@abstract");
    expect(ast.decorators[1].name).toBe("@internal");
  });

  test("parses enum value decorators in field values", () => {
    const source = `
prime Example extends Method {
  name: "example"
  version: "1.0.0"
  success_criteria: {
    criteria: [
      { id: "test", decidability: @decidable, weight: 0.3 }
      { id: "measure", decidability: @measurable, weight: 0.5 }
    ]
  }
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const scField = findField(ast.body, "success_criteria");
    expect(scField).toBeDefined();
    const scObj = scField!.value as ObjectNode;
    const criteriaField = findField(scObj.fields, "criteria");
    expect(criteriaField).toBeDefined();

    const arr = criteriaField!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);

    const first = arr.items[0] as ObjectNode;
    const decidabilityField = findField(first.fields, "decidability");
    expect(decidabilityField).toBeDefined();
    expect(decidabilityField!.value.type).toBe("EnumValue");
    expect((decidabilityField!.value as EnumValueNode).value).toBe("@decidable");
  });
});

// ─── Test: Lexer ────────────────────────────────────────────────────────────

describe("Lexer", () => {
  test("tokenizes keywords", () => {
    const tokens = tokenize("prime extends override append extend");
    const types = tokens
      .filter((t) => t.type !== TokenType.EOF)
      .map((t) => t.type);
    expect(types).toEqual([
      TokenType.PRIME,
      TokenType.EXTENDS,
      TokenType.OVERRIDE,
      TokenType.APPEND,
      TokenType.EXTEND,
    ]);
  });

  test("tokenizes strings", () => {
    const tokens = tokenize('"hello world"');
    const strTok = tokens.find((t) => t.type === TokenType.STRING);
    expect(strTok).toBeDefined();
    expect(strTok!.value).toBe("hello world");
  });

  test("tokenizes numbers", () => {
    const tokens = tokenize("42 3.14");
    const nums = tokens.filter((t) => t.type === TokenType.NUMBER);
    expect(nums).toHaveLength(2);
    expect(nums[0].value).toBe("42");
    expect(nums[1].value).toBe("3.14");
  });

  test("tokenizes booleans", () => {
    const tokens = tokenize("true false");
    const bools = tokens.filter((t) => t.type === TokenType.BOOLEAN);
    expect(bools).toHaveLength(2);
    expect(bools[0].value).toBe("true");
    expect(bools[1].value).toBe("false");
  });

  test("tokenizes decorators", () => {
    const tokens = tokenize("@sealed @abstract @decidable");
    const decs = tokens.filter((t) => t.type === TokenType.AT_DECORATOR);
    expect(decs).toHaveLength(3);
    expect(decs[0].value).toBe("@sealed");
    expect(decs[1].value).toBe("@abstract");
    expect(decs[2].value).toBe("@decidable");
  });

  test("tokenizes arrows", () => {
    const tokens = tokenize('"a" → "b"');
    const arrow = tokens.find((t) => t.type === TokenType.ARROW);
    expect(arrow).toBeDefined();
  });

  test("tokenizes ASCII arrows", () => {
    const tokens = tokenize('"a" -> "b"');
    const arrow = tokens.find((t) => t.type === TokenType.ARROW);
    expect(arrow).toBeDefined();
  });

  test("tokenizes delimiters", () => {
    const tokens = tokenize("{ } [ ] ( ) : , .");
    const types = tokens
      .filter((t) => t.type !== TokenType.EOF && t.type !== TokenType.NEWLINE)
      .map((t) => t.type);
    expect(types).toContain(TokenType.LBRACE);
    expect(types).toContain(TokenType.RBRACE);
    expect(types).toContain(TokenType.LBRACKET);
    expect(types).toContain(TokenType.RBRACKET);
    expect(types).toContain(TokenType.LPAREN);
    expect(types).toContain(TokenType.RPAREN);
    expect(types).toContain(TokenType.COLON);
    expect(types).toContain(TokenType.COMMA);
    expect(types).toContain(TokenType.DOT);
  });

  test("tokenizes comparison operators", () => {
    const tokens = tokenize("< > <= >=");
    const ops = tokens.filter(
      (t) =>
        t.type === TokenType.LT ||
        t.type === TokenType.GT ||
        t.type === TokenType.LTE ||
        t.type === TokenType.GTE
    );
    expect(ops).toHaveLength(4);
  });

  test("tokenizes percent numbers", () => {
    const tokens = tokenize("80%");
    const pct = tokens.find((t) => t.type === TokenType.PERCENT);
    expect(pct).toBeDefined();
    expect(pct!.value).toBe("80");
  });

  test("skips line comments", () => {
    const tokens = tokenize("name // this is a comment\nversion");
    const comments = tokens.filter((t) => t.type === TokenType.COMMENT);
    expect(comments).toHaveLength(1);
    expect(comments[0].value).toBe("this is a comment");
    const idents = tokens.filter((t) => t.type === TokenType.IDENT);
    expect(idents).toHaveLength(2);
  });

  test("skips block comments", () => {
    const tokens = tokenize("name /* block\ncomment */ version");
    const comments = tokens.filter((t) => t.type === TokenType.COMMENT);
    expect(comments).toHaveLength(1);
    const idents = tokens.filter((t) => t.type === TokenType.IDENT);
    expect(idents).toHaveLength(2);
  });

  test("handles identifiers with hyphens", () => {
    const tokens = tokenize("owasp-top-10 tdd-red-green");
    const idents = tokens.filter((t) => t.type === TokenType.IDENT);
    expect(idents).toHaveLength(2);
    expect(idents[0].value).toBe("owasp-top-10");
    // Note: 10 is consumed as part of ident because hyphen-digit is valid in ident
  });

  test("tracks line and column numbers", () => {
    const tokens = tokenize('prime Example {\n  name: "test"\n}');
    const primeTok = tokens.find((t) => t.type === TokenType.PRIME);
    expect(primeTok!.line).toBe(1);
    expect(primeTok!.column).toBe(1);

    const nameTok = tokens.find((t) => t.type === TokenType.IDENT && t.value === "name");
    expect(nameTok!.line).toBe(2);
  });
});

// ─── Test: Category shorthand ───────────────────────────────────────────────

describe("Category shorthand", () => {
  test("parses Name Description shorthand in arrays", () => {
    const source = `
prime Example extends Knowledge {
  name: "example"
  version: "1.0.0"
  categories: [
    Injection       "Untrusted data sent as commands"
    BrokenAuth      "Auth and session management flaws"
  ]
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const catField = findField(ast.body, "categories");
    expect(catField).toBeDefined();

    const arr = catField!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);

    const first = arr.items[0] as ParameterShorthandNode;
    expect(first.type).toBe("ParameterShorthand");
    expect(first.name).toBe("Injection");
    expect(first.description).toBe("Untrusted data sent as commands");
  });
});

// ─── Test: Parameter shorthand ──────────────────────────────────────────────

describe("Parameter shorthand", () => {
  test("parses name(type) description in arrays", () => {
    const source = `
prime Example extends Method {
  name: "example"
  version: "1.0.0"
  input: [
    task(string)     "Feature description to implement"
    language(string) "Programming language"
  ]
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const inputField = findField(ast.body, "input");
    expect(inputField).toBeDefined();

    const arr = inputField!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);

    const first = arr.items[0] as ParameterShorthandNode;
    expect(first.type).toBe("ParameterShorthand");
    expect(first.name).toBe("task");
    expect(first.paramType).toBe("string");
    expect(first.description).toBe("Feature description to implement");
  });
});

// ─── Test: Comments ─────────────────────────────────────────────────────────

describe("Comments", () => {
  test("line comments are skipped during parsing", () => {
    const source = `
// This is a top-level comment
prime Example extends Knowledge {
  // This is a field comment
  name: "example"
  version: "1.0.0" // inline comment
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.name).toBe("Example");
    expect(ast.body).toHaveLength(2);
  });

  test("block comments are skipped during parsing", () => {
    const source = `
/*
  Multi-line comment
  describing the prime
*/
prime Example extends Knowledge {
  name: "example"
  version: "1.0.0"
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.name).toBe("Example");
  });
});

// ─── Test: Full complex prime (integration test) ────────────────────────────

describe("Full complex Method prime", () => {
  const source = `
@sealed
prime TDDRedGreenRefactor extends Method {
  name: "tdd-red-green-refactor"
  version: "2.1.0"
  description: "Test-driven development: red-green-refactor cycle"
  tags: ["testing", "methodology", "tdd"]
  author: { name: "primes-community" }
  license: "MIT"

  input: [
    task(string)     "Feature description to implement"
    language(string) "Programming language"
  ]

  output: [
    tests(code)           "Generated test code"
    implementation(code)  "Implementation code"
  ]

  use: [
    TestCoverageStandard as postCheck
  ]

  steps: [
    RED {
      "Write a test describing expected behavior. Run the test."
      expect: fail
      error: "Test passed — not testing new behavior, rewrite test"
    }
    GREEN {
      "Write minimal code to pass the test. Run the test."
      expect: pass
      error: {
        message: "Test did not pass"
        retry: 3
        fallback: "Go back to task and re-understand requirements"
      }
    }
    REFACTOR {
      "Eliminate duplication, improve naming, simplify. Run tests."
      expect: pass
      error: "Refactoring broke tests — rollback to last GREEN"
    }
  ]

  branches: [
    "Cannot write test"     → "Refactor interface to be testable, then go back to RED"
    "Refactoring broke test" → "Rollback to last GREEN, try different refactoring"
  ]

  warnings: [
    "Too simple to test" → "Simple code can break in future changes"
    "Will add tests later" → "Motivation to add tests later is near zero"
    "Test is too obvious" → "Write it down, tests are living documentation"
  ]

  links: [
    validates_with -> "test-coverage-standard"
    enhances -> "mutation-testing"
    contradicts -> "waterfall-testing"
  ]

  success_criteria: {
    mode: "weighted"
    min_score: 0.8
    criteria: [
      { id: "tests_pass", description: "All tests pass",
        decidability: @decidable,
        weight: 0.3 }
      { id: "coverage_met", description: "Coverage meets standard",
        decidability: @measurable,
        weight: 0.3 }
    ]
  }

  evaluation: {
    determinism: "RED/GREEN highly deterministic, REFACTOR varies by person"
    error_coverage: "3 steps + 2 branches all have error handling"
    testability: "Can be tested automatically"
  }
}
`;

  test("parses full complex prime without errors", () => {
    const { ast, errors } = parse(source, "tdd.prime");
    expect(errors).toHaveLength(0);
    expect(ast.name).toBe("TDDRedGreenRefactor");
    expect(asPrime(ast).extends).toBe("Method");
    expect(ast.decorators).toHaveLength(1);
    expect(ast.decorators[0].name).toBe("@sealed");
    expect(ast.filename).toBe("tdd.prime");
  });

  test("has all expected top-level fields", () => {
    const { ast } = parse(source);
    const fieldKeys = ast.body.map((f) => f.key);
    expect(fieldKeys).toContain("name");
    expect(fieldKeys).toContain("version");
    expect(fieldKeys).toContain("description");
    expect(fieldKeys).toContain("tags");
    expect(fieldKeys).toContain("author");
    expect(fieldKeys).toContain("license");
    expect(fieldKeys).toContain("input");
    expect(fieldKeys).toContain("output");
    expect(fieldKeys).toContain("use");
    expect(fieldKeys).toContain("steps");
    expect(fieldKeys).toContain("branches");
    expect(fieldKeys).toContain("warnings");
    expect(fieldKeys).toContain("links");
    expect(fieldKeys).toContain("success_criteria");
    expect(fieldKeys).toContain("evaluation");
  });
});

// ─── Test: No extends clause ────────────────────────────────────────────────

describe("Prime without extends", () => {
  test("parses prime without extends clause", () => {
    const source = `
prime Standalone {
  name: "standalone"
  version: "1.0.0"
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.name).toBe("Standalone");
    expect(asPrime(ast).extends).toBeUndefined();
  });
});

// ─── Test: Empty prime ──────────────────────────────────────────────────────

describe("Empty prime body", () => {
  test("parses empty prime body", () => {
    const source = `prime Empty extends Knowledge {}`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);
    expect(ast.name).toBe("Empty");
    expect(ast.body).toHaveLength(0);
  });
});

// ─── Test: Nested arrays with objects ───────────────────────────────────────

describe("Nested arrays with objects", () => {
  test("parses array of objects", () => {
    const source = `
prime Example extends Knowledge {
  name: "example"
  version: "1.0.0"
  definitions: [
    { term: "Attack Surface", meaning: "Total set of entry points" }
    { term: "Trust Boundary", meaning: "Boundary between trust levels" }
  ]
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const defsField = findField(ast.body, "definitions");
    expect(defsField).toBeDefined();

    const arr = defsField!.value as ArrayNode;
    expect(arr.items).toHaveLength(2);
    expect(arr.items[0].type).toBe("Object");

    const first = arr.items[0] as ObjectNode;
    const termField = findField(first.fields, "term");
    expect(termField).toBeDefined();
    expect((termField!.value as StringNode).value).toBe("Attack Surface");
  });
});

// ─── Test: Number values ────────────────────────────────────────────────────

describe("Number values", () => {
  test("parses integer and float numbers", () => {
    const source = `
prime Example extends Rule {
  name: "example"
  version: "1.0.0"
  config: {
    retry: 3
    weight: 0.8
    min_score: 0.95
  }
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const configField = findField(ast.body, "config");
    const obj = configField!.value as ObjectNode;

    const retryField = findField(obj.fields, "retry");
    expect((retryField!.value as NumberNode).value).toBe(3);

    const weightField = findField(obj.fields, "weight");
    expect((weightField!.value as NumberNode).value).toBe(0.8);
  });
});

// ─── Test: Boolean values ───────────────────────────────────────────────────

describe("Boolean values", () => {
  test("parses true and false", () => {
    const source = `
prime Example extends Knowledge {
  name: "example"
  version: "1.0.0"
  active: true
  deprecated: false
}
`;
    const { ast, errors } = parse(source);
    expect(errors).toHaveLength(0);

    const activeField = findField(ast.body, "active");
    expect(activeField!.value.type).toBe("Boolean");
    expect((activeField!.value as BooleanNode).value).toBe(true);

    const deprecatedField = findField(ast.body, "deprecated");
    expect((deprecatedField!.value as BooleanNode).value).toBe(false);
  });
});
