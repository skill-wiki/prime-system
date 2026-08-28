/**
 * prime init — Create a new unit source file.
 *
 * The scaffold is deliberately type-agnostic. It used to carry three full field
 * skeletons (one per prime-v1 base type) listing that a Method has
 * `input/output/steps/success_criteria`, a Rule has `checks/thresholds`, and so
 * on. That is the engine shipping a domain ontology, which architecture §3.1
 * forbids: the CLI may know "a unit declares a type", never which types exist or
 * what fields each one requires. A per-type skeleton is a Model Package
 * artefact and belongs behind `prime sdk generate` (§11.4).
 */

import { writeFile, fileExists } from '../utils/fs';
import { header, success, info, bold, cyan, gray } from '../utils/display';

export async function initCommand(args: string[]) {
  header('Create a new Prime unit');

  const positional = args.filter((a) => !a.startsWith('-'));
  const name = positional[0] || (await prompt('Unit name (kebab-case): '));
  const typeFlagIndex = args.indexOf('--type');
  const typeName =
    typeFlagIndex !== -1 && args[typeFlagIndex + 1]
      ? args[typeFlagIndex + 1]!
      : positional[1] || (await prompt('Type name (as declared by your model package): '));

  if (!name || !typeName) {
    console.error('Usage: prime init <unit-name> --type <TypeName>');
    process.exit(1);
  }

  const description = await prompt('Description: ');
  const tags = (await prompt('Tags (comma-separated): ')).split(',').map((t) => t.trim()).filter(Boolean);

  const fileName = `${name}.prime`;
  if (fileExists(fileName)) {
    console.error(`File ${fileName} already exists.`);
    process.exit(1);
  }

  await writeFile(fileName, generateTemplate(name, typeName, description, tags));

  console.log();
  success(`Created ${bold(fileName)}`);
  console.log();
  info(`Fields for type ${bold(typeName)} come from your model package, not from this CLI.`);
  console.log(cyan('  Next steps:'));
  console.log(`  1. Add the fields ${typeName} declares (see your model package, or run prime sdk generate)`);
  console.log(`  2. Run ${bold('prime compile ' + fileName)} to check and compile`);
  console.log(`  ${gray('Relations are written as  <verb> "@scope/target"  — any verb your model declares.')}`);
}

/**
 * Emits only fields that are universal to every unit regardless of type, plus
 * the declaration header. Anything type-specific is left to the model package.
 */
export function generateTemplate(name: string, typeName: string, description: string, tags: string[]): string {
  const className = name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  const tagsStr = tags.map((t) => `"${t}"`).join(', ');

  return `${typeName} ${className} {

  name: "${name}"
  version: "0.1.0"
  description: "${description}"
  tags: [${tagsStr}]
  author: { name: "${process.env.USER || 'author'}" }
  license: "MIT"

  // Type-specific fields: see the definition of ${typeName} in your model package.

  // Relations use the verbs your model package declares, e.g.
  //   some_verb "@scope/other-unit"
}
`;
}

async function prompt(message: string): Promise<string> {
  process.stdout.write(message);
  const n = await Bun.stdin.stream().getReader().read();
  return new TextDecoder().decode(n.value).trim();
}
