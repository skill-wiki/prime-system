/**
 * prime info <name> — View Prime details.
 */

import { resolve, join } from 'path';
import { header, bold, cyan, green, yellow, gray, red } from '../utils/display';
import { findPrimesDir, readFile, fileExists } from '../utils/fs';

export async function infoCommand(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error('Usage: prime info <name>');
    process.exit(1);
  }

  // Try local first
  const localPaths = [
    resolve('primes', `${name}.prime`),
    resolve('.primes/source', `${name}.prime`),
  ];

  let source: string | null = null;
  let sourcePath: string | null = null;

  for (const p of localPaths) {
    if (fileExists(p)) {
      source = await readFile(p);
      sourcePath = p;
      break;
    }
  }

  if (!source) {
    // Try registry
    try {
      const resp = await fetch(`https://prime.dev/api/primes/${name}`);
      if (resp.ok) {
        const data = await resp.json() as any;
        displayInfo(data);
        return;
      }
    } catch {}
    console.error(`Prime '${name}' not found locally or on prime.dev`);
    process.exit(1);
  }

  // Parse and display
  const typeMatch = source.match(/extends\s+(\w+)/);
  const versionMatch = source.match(/version:\s*"([^"]+)"/);
  const descMatch = source.match(/description:\s*"([^"]+)"/);
  const tagsMatch = source.match(/tags:\s*\[([^\]]+)\]/);
  const authorMatch = source.match(/author:\s*\{[^}]*name:\s*"([^"]+)"/);
  const licenseMatch = source.match(/license:\s*"([^"]+)"/);

  const type = typeMatch?.[1]?.toLowerCase() || 'unknown';
  const version = versionMatch?.[1] || '?';
  const description = descMatch?.[1] || '';
  const tags = tagsMatch?.[1]?.replace(/"/g, '').split(',').map(t => t.trim()) || [];
  const author = authorMatch?.[1] || '?';
  const license = licenseMatch?.[1] || '?';

  const typeColor = type === 'knowledge' ? cyan : type === 'method' ? green : yellow;

  header(name);
  console.log(`  ${typeColor(type)} | v${version} | ${license}`);
  console.log(`  ${gray(description)}`);
  console.log();
  console.log(`  Author:  ${author}`);
  console.log(`  Tags:    ${tags.map(t => cyan(t)).join(', ')}`);
  console.log(`  Source:  ${gray(sourcePath || 'registry')}`);

  // Check compiled version
  const primesDir = findPrimesDir();
  if (primesDir) {
    const compiledPath = join(primesDir, 'compiled', `${name}.md`);
    if (fileExists(compiledPath)) {
      const compiled = await readFile(compiledPath);
      const sourceTokens = estimateTokens(source);
      const compiledTokens = estimateTokens(compiled);
      console.log(`  Compiled: ${green('✅')} (${sourceTokens} → ${compiledTokens} tokens, ${Math.round((1 - compiledTokens/sourceTokens)*100)}% reduction)`);
    } else {
      console.log(`  Compiled: ${gray('—')} (run prime compile)`);
    }
  }

  // Extract links
  const links: string[] = [];
  const linkPatterns = [
    { regex: /requires\s+"([^"]+)"/g, prefix: 'requires' },
    { regex: /validates_with\s+"([^"]+)"/g, prefix: 'validates' },
    { regex: /enhances\s+"([^"]+)"/g, prefix: 'enhances' },
    { regex: /contradicts\s+"([^"]+)"/g, prefix: red('contradicts') },
  ];
  for (const p of linkPatterns) {
    let m;
    while ((m = p.regex.exec(source)) !== null) {
      links.push(`${p.prefix} → ${m[1]}`);
    }
  }

  if (links.length > 0) {
    console.log();
    console.log(`  ${bold('Links:')}`);
    for (const l of links) {
      console.log(`    ${l}`);
    }
  }

  // Show success criteria count for methods
  if (type === 'method') {
    const scCount = (source.match(/id:\s*"/g) || []).length;
    if (scCount > 0) {
      console.log();
      console.log(`  ${bold('Evaluation:')} ${scCount} success criteria defined`);
    }
  }

  // Show checks count for rules
  if (type === 'rule') {
    const checkCount = (source.match(/description:\s*"/g) || []).length;
    if (checkCount > 0) {
      console.log();
      console.log(`  ${bold('Checks:')} ${checkCount} checks defined`);
    }
  }
}

function displayInfo(data: any) {
  header(data.name || 'unknown');
  console.log(`  ${data.type || '?'} | v${data.version || '?'} | ${data.license || '?'}`);
  console.log(`  ${gray(data.description || '')}`);
  if (data.downloads) console.log(`  Downloads: ${data.downloads}`);
  if (data.rating) console.log(`  Rating: ${'★'.repeat(Math.round(data.rating))}`);
}

function estimateTokens(text: string): number {
  const cjkChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(otherChars / 4 + cjkChars / 2);
}
