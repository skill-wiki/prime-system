/**
 * prime graph <file.prime> [--format ascii|svg] — Visualize relationship graph.
 */

import { resolve, basename } from 'path';
import { header, bold, cyan, green, yellow, red, gray } from '../utils/display';
import { readFile, fileExists } from '../utils/fs';

export async function graphCommand(args: string[]) {
  const file = args[0];
  if (!file) {
    console.error('Usage: prime graph <file.prime>');
    process.exit(1);
  }

  const filePath = resolve(file);
  if (!fileExists(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  header(`Relationship Graph: ${basename(filePath)}`);

  const source = await readFile(filePath);
  const name = source.match(/name:\s*"([^"]+)"/)?.[1] || basename(file, '.prime');
  const type = source.match(/extends\s+(\w+)/)?.[1]?.toLowerCase() || 'prime';

  // Extract all relationships
  const links: { type: string; to: string; required: boolean }[] = [];

  const patterns = [
    { regex: /requires\s+"([^"]+)"/g, type: 'REQUIRES', required: true },
    { regex: /validates_with\s+"([^"]+)"/g, type: 'VALIDATES', required: true },
    { regex: /enhances\s+"([^"]+)"/g, type: 'ENHANCES', required: false },
    { regex: /contradicts\s+"([^"]+)"/g, type: 'CONTRADICTS', required: true },
    { regex: /specializes\s+"([^"]+)"/g, type: 'SPECIALIZES', required: false },
    { regex: /supplies_to\s+"([^"]+)"/g, type: 'SUPPLIES', required: true },
  ];

  for (const p of patterns) {
    let m;
    while ((m = p.regex.exec(source)) !== null) {
      links.push({ type: p.type, to: m[1], required: p.required });
    }
  }

  // Also extract use references
  const useMatches = source.matchAll(/(?:^|\s)(\w[\w-]+)\s+as\s+\w+/gm);
  for (const m of useMatches) {
    if (!links.some(l => l.to === m[1].toLowerCase())) {
      links.push({ type: 'USE', to: m[1], required: true });
    }
  }

  // Render ASCII graph
  const typeColor = type === 'knowledge' ? cyan : type === 'method' ? green : yellow;

  console.log();
  console.log(`  ${drawBox(name, typeColor)}`);

  if (links.length === 0) {
    console.log(gray('  (no relationships declared)'));
    return;
  }

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const isLast = i === links.length - 1;
    const connector = isLast ? '└' : '├';
    const arrow = link.type === 'CONTRADICTS' ? '──✕' : link.required ? '──→' : '- -→';
    const linkColor = link.type === 'CONTRADICTS' ? red : link.required ? bold : gray;

    console.log(`  ${connector}── ${linkColor(link.type)} ${arrow} ${bold(link.to)}`);
  }

  console.log();
  console.log(gray('  Legend: ──→ required  - -→ optional  ──✕ contradicts'));
}

function drawBox(text: string, colorFn: (s: string) => string): string {
  const width = text.length + 4;
  const top = '┌' + '─'.repeat(width) + '┐';
  const mid = '│  ' + colorFn(bold(text)) + '  │';
  const bot = '└' + '─'.repeat(width) + '┘';
  return `${top}\n  ${mid}\n  ${bot}`;
}
