/**
 * prime compose --name <name> — Compose Primes into a new Skill.
 */

import { resolve, join } from 'path';
import { header, success, info, bold, green, gray, cyan, yellow } from '../utils/display';
import { writeFile, findPrimesDir } from '../utils/fs';
import { readdirSync, readFileSync, existsSync } from 'fs';

export async function composeCommand(args: string[]) {
  let name = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) name = args[++i];
  }

  if (!name) {
    console.error('Usage: prime compose --name <skill-name>');
    process.exit(1);
  }

  header(`Compose Skill: ${bold(name)}`);

  // Find available primes
  const available = findAvailablePrimes();

  if (available.length === 0) {
    info('No Primes available. Install some first: prime install <name>');
    process.exit(0);
  }

  console.log('  Available Primes:\n');
  for (const p of available) {
    const typeColor = p.type === 'knowledge' ? cyan : p.type === 'method' ? green : yellow;
    console.log(`  ${typeColor(`[${p.type[0].toUpperCase()}]`)} ${bold(p.name)} — ${gray(p.description)}`);
  }

  // Auto-detect relationships
  console.log(`\n  ${bold('Auto-detected relationships:')}`);
  const relationships = detectRelationships(available);
  for (const rel of relationships) {
    console.log(gray(`    ${rel.from} --${rel.type}--> ${rel.to}`));
  }

  // Generate SKILL.md
  const skillContent = generateSkill(name, available, relationships);
  const outputDir = resolve(name);
  const outputPath = join(outputDir, 'SKILL.md');

  await writeFile(outputPath, skillContent);

  console.log();
  success(`Created ${bold(outputPath)}`);
  console.log();
  console.log(cyan('  Generated SKILL.md preview:'));
  console.log(gray('  ─'.repeat(30)));

  // Print preview (first 30 lines)
  const preview = skillContent.split('\n').slice(0, 30);
  for (const line of preview) {
    console.log(`  ${gray(line)}`);
  }
  if (skillContent.split('\n').length > 30) {
    console.log(gray('  ...'));
  }

  console.log();
  info(`Edit ${outputPath} to customize the workflow`);
  info(`Run ${bold('prime install')} in ${name}/ to install the Primes`);
}

interface AvailablePrime {
  name: string;
  type: string;
  description: string;
  version: string;
  links: string[];
}

function findAvailablePrimes(): AvailablePrime[] {
  const dirs = [
    resolve('primes'),
    resolve('.primes/source'),
  ];

  const primes: AvailablePrime[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(f => f.endsWith('.prime'));

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');
      const name = file.replace('.prime', '');
      const typeMatch = content.match(/extends\s+(\w+)/);
      const descMatch = content.match(/description:\s*"([^"]+)"/);
      const versionMatch = content.match(/version:\s*"([^"]+)"/);

      const links: string[] = [];
      const linkMatches = content.matchAll(/(?:requires|validates_with|enhances|contradicts|supplies_to)\s+"([^"]+)"/g);
      for (const m of linkMatches) links.push(m[1]);

      primes.push({
        name,
        type: typeMatch?.[1]?.toLowerCase() || 'unknown',
        description: descMatch?.[1] || '',
        version: versionMatch?.[1] || '0.1.0',
        links,
      });
    }
  }

  return primes;
}

interface Relationship {
  from: string;
  to: string;
  type: string;
}

function detectRelationships(primes: AvailablePrime[]): Relationship[] {
  const relationships: Relationship[] = [];
  const nameSet = new Set(primes.map(p => p.name));

  for (const p of primes) {
    for (const link of p.links) {
      if (nameSet.has(link)) {
        relationships.push({
          from: p.name,
          to: link,
          type: 'REQUIRES',
        });
      }
    }

    // Auto-detect VALIDATES relationships (Rule → Method)
    if (p.type === 'rule') {
      for (const other of primes) {
        if (other.type === 'method') {
          relationships.push({
            from: other.name,
            to: p.name,
            type: 'VALIDATES',
          });
        }
      }
    }
  }

  return relationships;
}

function generateSkill(name: string, primes: AvailablePrime[], relationships: Relationship[]): string {
  const knowledge = primes.filter(p => p.type === 'knowledge');
  const methods = primes.filter(p => p.type === 'method');
  const rules = primes.filter(p => p.type === 'rule');

  let md = `---\n`;
  md += `name: ${name}\n`;
  md += `description: Composed from ${primes.length} Primes\n`;
  md += `primes:\n`;
  for (const p of primes) {
    md += `  - ${p.name}@${p.version}\n`;
  }
  md += `---\n\n`;
  md += `# ${name.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')}\n\n`;

  let step = 1;

  if (knowledge.length > 0) {
    md += `## Context\n\n`;
    for (const k of knowledge) {
      md += `${step}. Load **${k.name}** for domain context\n`;
      step++;
    }
    md += `\n`;
  }

  if (methods.length > 0) {
    md += `## Execution\n\n`;
    for (const m of methods) {
      md += `${step}. Execute **${m.name}** — ${m.description}\n`;
      step++;
    }
    md += `\n`;
  }

  if (rules.length > 0) {
    md += `## Validation\n\n`;
    for (const r of rules) {
      md += `${step}. Validate with **${r.name}** — ${r.description}\n`;
      step++;
    }
    md += `\n`;
  }

  md += `## Decision\n\n`;
  md += `${step}. Combine all findings and validation results\n`;
  md += `${step + 1}. Output final verdict\n`;

  return md;
}
