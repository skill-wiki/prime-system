/**
 * aoe info <name> — View AOE details.
 */

import { resolve, join } from 'path';
import { header, bold, cyan, green, yellow, gray } from '../utils/display';
import { findPrimesDir, readFile, fileExists } from '../utils/fs';
import { extractRelations, extractKind } from '../utils/relations';
import { paintFor } from '../utils/kind-color';

export async function infoCommand(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error('Usage: aoe info <name>');
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
    console.error(`AOE '${name}' not found locally or on prime.dev`);
    process.exit(1);
  }

  // Parse and display
  const versionMatch = source.match(/version:\s*"([^"]+)"/);
  const descMatch = source.match(/description:\s*"([^"]+)"/);
  const tagsMatch = source.match(/tags:\s*\[([^\]]+)\]/);
  const authorMatch = source.match(/author:\s*\{[^}]*name:\s*"([^"]+)"/);
  const licenseMatch = source.match(/license:\s*"([^"]+)"/);

  const type = extractKind(source, name) ?? 'unknown';
  const version = versionMatch?.[1] || '?';
  const description = descMatch?.[1] || '';
  const tags = tagsMatch?.[1]?.replace(/"/g, '').split(',').map(t => t.trim()) || [];
  const author = authorMatch?.[1] || '?';
  const license = licenseMatch?.[1] || '?';

  const typeColor = paintFor(type);

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
      console.log(`  Compiled: ${gray('—')} (run aoe compile)`);
    }
  }

  // Relations, rendered uniformly. The previous version listed four hardcoded
  // verbs and painted one of them red, i.e. it decided locally that
  // `contradicts` is the dangerous one. §3.1 puts that decision in the model.
  const { relations, parseErrors } = extractRelations(source, name);
  if (parseErrors.length > 0) {
    console.log();
    for (const message of parseErrors) console.log(`  ${yellow('⚠️')} ${message}`);
  }

  if (relations.length > 0) {
    console.log();
    console.log(`  ${bold('Relations:')}`);
    const verbWidth = Math.max(...relations.map((r) => r.verb.length));
    for (const rel of relations) {
      console.log(`    ${rel.verb.padEnd(verbWidth)} → ${rel.target}`);
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
