/**
 * prime ls — List installed Primes.
 */

import { header, bold, cyan, green, yellow, gray } from '../utils/display';
import { findPrimesDir } from '../utils/fs';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

export async function lsCommand(_args: string[]) {
  const primesDir = findPrimesDir();
  if (!primesDir) {
    console.log('  No .primes/ directory found. Install primes with: prime install <name>');
    return;
  }

  header('Installed Primes');

  const sourceDir = join(primesDir, 'source');
  const compiledDir = join(primesDir, 'compiled');

  if (!existsSync(sourceDir)) {
    console.log('  No primes installed.\n');
    return;
  }

  const files = readdirSync(sourceDir).filter(f => f.endsWith('.prime'));
  if (files.length === 0) {
    console.log('  No primes installed.\n');
    return;
  }

  const rows: string[][] = [
    [bold('Name'), bold('Type'), bold('Version'), bold('Compiled?')],
  ];

  for (const file of files) {
    const content = readFileSync(join(sourceDir, file), 'utf-8');
    const name = file.replace('.prime', '');
    const typeMatch = content.match(/extends\s+(\w+)/);
    const versionMatch = content.match(/version:\s*"([^"]+)"/);
    const hasCompiled = existsSync(join(compiledDir, `${name}.md`));

    const type = typeMatch?.[1]?.toLowerCase() || 'unknown';
    const version = versionMatch?.[1] || '?';
    const typeColor = type === 'knowledge' ? cyan : type === 'method' ? green : yellow;
    const compiled = hasCompiled ? green('✅') : gray('—');

    rows.push([name, typeColor(type), version, compiled]);
  }

  // Align columns
  const colWidths = rows[0].map((_, i) => Math.max(...rows.map(r => stripAnsi(r[i]).length)));
  for (const row of rows) {
    const formatted = row.map((cell, i) => {
      const pad = colWidths[i] - stripAnsi(cell).length;
      return cell + ' '.repeat(Math.max(0, pad));
    }).join('  ');
    console.log(`  ${formatted}`);
  }

  console.log(`\n  ${gray(`${files.length} primes installed in ${primesDir}`)}`);
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}
