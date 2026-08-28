/**
 * prime search <query> [--type <type>] [--tag <tag>]
 */

import { header, bold, gray, yellow } from '../utils/display';
import { paintFor } from '../utils/kind-color';

const REGISTRY_URL = 'https://prime.dev/api';

export async function searchCommand(args: string[]) {
  const { query, type, tag } = parseSearchFlags(args);

  if (!query) {
    console.error('Usage: prime search <query> [--type knowledge|method|rule] [--tag <tag>]');
    process.exit(1);
  }

  header(`Search: "${query}"`);

  try {
    const params = new URLSearchParams({ q: query });
    if (type) params.set('type', type);
    if (tag) params.set('tag', tag);

    const response = await fetch(`${REGISTRY_URL}/search?${params}`);

    if (!response.ok) {
      throw new Error('Registry unavailable');
    }

    const results = await response.json() as any[];
    displayResults(results);
  } catch (e) {
    // Offline mode: search local primes
    console.log(gray('  Registry unavailable. Searching local primes...\n'));
    await searchLocal(query, type, tag);
  }
}

function displayResults(results: any[]) {
  if (results.length === 0) {
    console.log('  No results found.\n');
    return;
  }

  for (const r of results) {
    // See ls.ts: the paint is a stable hash of the type name, so a registry
    // returning a type this CLI has never seen renders exactly as well.
    const typeColor = paintFor(String(r.type ?? ''));
    const stars = '★'.repeat(Math.round(r.rating || 0)) + '☆'.repeat(5 - Math.round(r.rating || 0));

    console.log(`  ${bold(r.name)}  ${typeColor(r.type)}  ${yellow(stars)}  ${gray(`${r.downloads || 0} uses`)}`);
    console.log(`  ${gray(r.description || '')}`);

    if (r.links && r.links.length > 0) {
      const linkStrs = r.links.map((l: any) => `${l.type.toLowerCase()}: ${l.to}`);
      console.log(`  ${gray(`links: ${linkStrs.join(', ')}`)}`);
    }

    console.log();
  }

  console.log(gray(`  ${results.length} results found`));
}

async function searchLocal(query: string, type?: string, tag?: string) {
  const { readdirSync, readFileSync, existsSync } = await import('fs');
  const { join, resolve } = await import('path');

  const searchDirs = [
    resolve('primes'),
    resolve('.primes/source'),
  ];

  const results: any[] = [];
  const queryLower = query.toLowerCase();

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(f => f.endsWith('.prime'));

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8');
      const name = file.replace('.prime', '');

      // Check if query matches name, description, or tags
      if (name.includes(queryLower) || content.toLowerCase().includes(queryLower)) {
        const descMatch = content.match(/description:\s*"([^"]+)"/);
        const typeMatch = content.match(/extends\s+(\w+)/);
        const tagsMatch = content.match(/tags:\s*\[([^\]]+)\]/);

        const primeType = typeMatch?.[1]?.toLowerCase() || 'unknown';

        if (type && primeType !== type) continue;
        if (tag && tagsMatch && !tagsMatch[1].includes(tag)) continue;

        results.push({
          name,
          type: primeType,
          description: descMatch?.[1] || '',
          rating: 0,
          downloads: 0,
          source: 'local'
        });
      }
    }
  }

  if (results.length === 0) {
    console.log('  No local results found.\n');
  } else {
    displayResults(results);
    console.log(gray('  (local results only — registry unavailable)'));
  }
}

function parseSearchFlags(args: string[]) {
  let query = '';
  let type: string | undefined;
  let tag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && args[i + 1]) { type = args[++i]; }
    else if (args[i] === '--tag' && args[i + 1]) { tag = args[++i]; }
    else if (!args[i].startsWith('-')) { query += (query ? ' ' : '') + args[i]; }
  }

  return { query, type, tag };
}
