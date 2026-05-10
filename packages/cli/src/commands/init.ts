/**
 * prime init — Create a new .prime file interactively.
 */

import { writeFile, fileExists } from '../utils/fs';
import { header, success, info, bold, cyan } from '../utils/display';

export async function initCommand(args: string[]) {
  header('Create a new Prime');

  const name = args[0] || await prompt('Prime name (kebab-case): ');
  const typeChoice = await prompt('Type — (K)nowledge, (M)ethod, or (R)ule? [M]: ');
  const baseClass = typeChoice.toLowerCase().startsWith('k') ? 'Knowledge'
    : typeChoice.toLowerCase().startsWith('r') ? 'Rule'
    : 'Method';
  const description = await prompt('Description: ');
  const tags = (await prompt('Tags (comma-separated): ')).split(',').map(t => t.trim()).filter(Boolean);

  const fileName = `${name}.prime`;

  if (fileExists(fileName)) {
    console.error(`File ${fileName} already exists.`);
    process.exit(1);
  }

  const content = generateTemplate(name, baseClass, description, tags);
  await writeFile(fileName, content);

  console.log();
  success(`Created ${bold(fileName)}`);
  console.log();
  console.log(cyan('  Next steps:'));
  console.log(`  1. Edit ${fileName} to fill in content`);
  console.log(`  2. Run ${bold('prime compile ' + fileName)} to check and compile`);
  console.log(`  3. Run ${bold('prime publish')} to share on prime.dev`);
}

function generateTemplate(name: string, baseClass: string, description: string, tags: string[]): string {
  const className = name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  const tagsStr = tags.map(t => `"${t}"`).join(', ');

  if (baseClass === 'Knowledge') {
    return `prime ${className} extends Knowledge {

  name: "${name}"
  version: "0.1.0"
  description: "${description}"
  tags: [${tagsStr}]
  author: { name: "${process.env.USER || 'author'}" }
  license: "MIT"

  // Define at least one of: definitions, categories, facts
  categories: [
    // CategoryName  "description"
  ]

  // Optional
  definitions: [
    // { term: "X", meaning: "Y" }
  ]

  relationships: [
    // { from: "A", relation: "causes", to: "B" }
  ]

  sources: [
    // { title: "Source", url: "https://..." }
  ]

  links: [
    // supplies_to "other-prime"
  ]

  evaluation: {
    completeness: ""
    accuracy: ""
  }
}
`;
  }

  if (baseClass === 'Rule') {
    return `prime ${className} extends Rule {

  name: "${name}"
  version: "0.1.0"
  description: "${description}"
  tags: [${tagsStr}]
  author: { name: "${process.env.USER || 'author'}" }
  license: "MIT"

  checks: [
    // { description: "Check description", pass: "condition", weight: 0.25 }
  ]

  thresholds: [
    // metric_name  block: < 60%  warn: < 80%  pass: >= 80%
  ]

  severity: {
    block: "Must fix before proceeding"
    warn: "May proceed with noted issues"
    pass: "Approved"
  }

  exemptions: [
    // "condition" → "reason"
  ]

  applies_to: {
    prime_types: ["Method"]
  }

  evaluation: {
    decidability: ""
    completeness: ""
    consistency: ""
  }
}
`;
  }

  // Default: Method
  return `prime ${className} extends Method {

  name: "${name}"
  version: "0.1.0"
  description: "${description}"
  tags: [${tagsStr}]
  author: { name: "${process.env.USER || 'author'}" }
  license: "MIT"

  input: [
    // param(type)  "description"
  ]

  output: [
    // result(type)  "description"
  ]

  require: [
    // "precondition"
    //   error: "message if not met"
  ]

  use: [
    // OtherPrime as alias
  ]

  steps: [
    // STEP_NAME {
    //   "Natural language description of what to do"
    //   expect: pass
    //   error: "What to do if it fails"
    // }
  ]

  loop: until "completion condition" max: 10

  warnings: [
    // "common mistake" → "correction"
  ]

  branches: [
    // "exception condition" → "how to handle"
  ]

  links: [
    // validates_with "some-rule"
    // requires "some-knowledge"
  ]

  success_criteria: {
    mode: "weighted"
    min_score: 0.8
    criteria: [
      // { id: "x", description: "X", decidability: @decidable,
      //   verify: { type: "check", condition: "..." }, weight: 0.25 }
    ]
  }

  failure_criteria: {
    mode: "any"
    criteria: [
      // { id: "x", description: "X", decidability: @decidable,
      //   verify: { type: "check", condition: "..." } }
    ]
  }

  evaluation: {
    determinism: ""
    error_coverage: ""
    testability: ""
    scope: ""
  }
}
`;
}

async function prompt(message: string): Promise<string> {
  process.stdout.write(message);
  const buf = new Uint8Array(1024);
  const n = await Bun.stdin.stream().getReader().read();
  return new TextDecoder().decode(n.value).trim();
}
