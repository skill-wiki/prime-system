/**
 * File system utilities for CLI.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve, dirname } from 'path';

/** Find .primes/ directory in current or parent directories */
export function findPrimesDir(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    const primesDir = join(dir, '.primes');
    if (existsSync(primesDir) && statSync(primesDir).isDirectory()) {
      return primesDir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Ensure .primes/ directory exists */
export function ensurePrimesDir(dir: string = process.cwd()): string {
  const primesDir = join(dir, '.primes');
  const compiledDir = join(primesDir, 'compiled');
  const sourceDir = join(primesDir, 'source');
  mkdirSync(compiledDir, { recursive: true });
  mkdirSync(sourceDir, { recursive: true });
  return primesDir;
}

/** List all .prime files in a directory */
export function listPrimeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.prime'))
    .map(f => join(dir, f));
}

/** List all installed primes */
export function listInstalledPrimes(primesDir: string): { name: string; version: string; type: string }[] {
  const sourceDir = join(primesDir, 'source');
  if (!existsSync(sourceDir)) return [];
  const files = readdirSync(sourceDir).filter(f => f.endsWith('.prime'));
  return files.map(f => {
    const content = Bun.file(join(sourceDir, f)).text();
    // Quick parse to extract name and version from frontmatter
    const name = f.replace('.prime', '');
    return { name, version: '0.0.0', type: 'unknown' };
  });
}

/** Read file as string */
export async function readFile(path: string): Promise<string> {
  return Bun.file(path).text();
}

/** Write file */
export async function writeFile(path: string, content: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, content);
}

/** Check if file exists */
export function fileExists(path: string): boolean {
  return existsSync(path);
}
