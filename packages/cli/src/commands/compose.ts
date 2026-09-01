/**
 * aoe compose --name <name> — Compose units into a new Skill document.
 *
 * Two domain assertions were removed here, both named by architecture §3.1:
 *
 *  1. A hardcoded verb regex decided which statements count as a dependency.
 *     Relations are now read from the AST, so a verb the CLI has never seen is
 *     composed exactly like `requires`.
 *  2. The generated document was structured as Context/Execution/Validation by
 *     bucketing units into knowledge/method/rule, and a `rule` was auto-linked
 *     to every `method` as a VALIDATES edge. That is a relation the model never
 *     declared — the CLI invented it from a pair of type names. Sections are now
 *     one-per-declared-kind, in a stable order, and no edge is synthesised.
 */

import { resolve, join } from 'path';
import { header, success, info, bold, gray, cyan } from '../utils/display';
import { writeFile } from '../utils/fs';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { extractRelations, extractKind, extractStringField } from '../utils/relations';
import { paintFor } from '../utils/kind-color';

export async function composeCommand(args: string[]) {
  let name = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) name = args[++i];
  }

  if (!name) {
    console.error('Usage: aoe compose --name <skill-name>');
    process.exit(1);
  }

  header(`Compose Skill: ${bold(name)}`);

  const available = findAvailablePrimes();

  if (available.length === 0) {
    info('No units available. Install some first: aoe install <name>');
    process.exit(0);
  }

  console.log('  Available units:\n');
  for (const p of available) {
    const paint = paintFor(p.kind);
    console.log(`  ${paint(`[${p.kind || '?'}]`)} ${bold(p.name)} — ${gray(p.description)}`);
  }

  console.log(`\n  ${bold('Declared relations between available units:')}`);
  const relationships = collectRelationships(available);
  if (relationships.length === 0) {
    console.log(gray('    (none — every relation target is outside this set)'));
  }
  for (const rel of relationships) {
    console.log(gray(`    ${rel.from} --${rel.verb}--> ${rel.to}`));
  }

  const skillContent = generateSkill(name, available, relationships);
  const outputDir = resolve(name);
  const outputPath = join(outputDir, 'SKILL.md');

  await writeFile(outputPath, skillContent);

  console.log();
  success(`Created ${bold(outputPath)}`);
  console.log();
  console.log(cyan('  Generated SKILL.md preview:'));
  console.log(gray('  ─'.repeat(30)));

  const preview = skillContent.split('\n').slice(0, 30);
  for (const line of preview) {
    console.log(`  ${gray(line)}`);
  }
  if (skillContent.split('\n').length > 30) {
    console.log(gray('  ...'));
  }

  console.log();
  info(`Edit ${outputPath} to customize the workflow`);
  info(`Run ${bold('aoe install')} in ${name}/ to install the units`);
}

export interface AvailablePrime {
  readonly name: string;
  /** The kind as declared. Opaque: the CLI never branches on its value. */
  readonly kind: string;
  readonly description: string;
  readonly version: string;
  readonly links: readonly { readonly verb: string; readonly target: string }[];
}

function findAvailablePrimes(): AvailablePrime[] {
  const dirs = [resolve('primes'), resolve('.primes/source')];
  const primes: AvailablePrime[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.prime'))) {
      const content = readFileSync(join(dir, file), 'utf-8');
      const name = file.replace('.prime', '');
      const { relations } = extractRelations(content, file);
      primes.push({
        name,
        kind: extractKind(content, file) ?? '',
        description: extractStringField(content, 'description', file) ?? '',
        version: extractStringField(content, 'version', file) ?? '0.1.0',
        links: relations.map((r) => ({ verb: r.verb, target: r.target })),
      });
    }
  }

  return primes;
}

export interface Relationship {
  readonly from: string;
  readonly to: string;
  readonly verb: string;
}

/** Reports the relations the sources declare. Synthesises nothing. */
export function collectRelationships(primes: readonly AvailablePrime[]): Relationship[] {
  const nameSet = new Set(primes.map((p) => p.name));
  const relationships: Relationship[] = [];
  for (const p of primes) {
    for (const link of p.links) {
      const bare = link.target.replace(/^@[^/]+\//, '');
      if (nameSet.has(link.target)) relationships.push({ from: p.name, to: link.target, verb: link.verb });
      else if (nameSet.has(bare)) relationships.push({ from: p.name, to: bare, verb: link.verb });
    }
  }
  return relationships;
}

/**
 * One section per declared kind, kinds in first-appearance order so the output is
 * stable without ranking them. Numbering stays continuous across sections so the
 * document still reads as a sequence.
 */
export function generateSkill(
  name: string,
  primes: readonly AvailablePrime[],
  relationships: readonly Relationship[],
): string {
  const byKind = new Map<string, AvailablePrime[]>();
  for (const p of primes) {
    const key = p.kind || 'unit';
    const bucket = byKind.get(key);
    if (bucket === undefined) byKind.set(key, [p]);
    else bucket.push(p);
  }

  let md = `---\n`;
  md += `name: ${name}\n`;
  md += `description: Composed from ${primes.length} units\n`;
  md += `primes:\n`;
  for (const p of primes) md += `  - ${p.name}@${p.version}\n`;
  md += `---\n\n`;
  md += `# ${name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')}\n\n`;

  let step = 1;
  for (const [kind, units] of byKind) {
    md += `## ${kind}\n\n`;
    for (const u of units) {
      md += `${step}. **${u.name}**${u.description ? ` — ${u.description}` : ''}\n`;
      step++;
    }
    md += `\n`;
  }

  if (relationships.length > 0) {
    md += `## Declared relations\n\n`;
    for (const rel of relationships) md += `- ${rel.from} \`${rel.verb}\` ${rel.to}\n`;
    md += `\n`;
  }

  return md;
}
