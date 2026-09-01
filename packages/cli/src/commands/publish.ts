/**
 * aoe publish — Publish a .prime file to a registry.
 *
 * Default registry: `AOE_REGISTRY` env var, falling back to no default
 * (the user must pass `--remote <url>`). Bare-fetch PUTs the source file
 * to `<base>/atoms/<id>.prime` (mirroring the GET path used by install).
 *
 * Auth: `AOE_REGISTRY_TOKEN` env var, sent as `Authorization: Bearer <token>`.
 */

import { resolve, basename } from 'path';
import { header, success, error, info, createSpinner, bold, green, gray } from '../utils/display';
import { readFile, fileExists } from '../utils/fs';

export async function publishCommand(args: string[]) {
  // ── arg parsing ──
  let file: string | null = null;
  let remoteUrl: string | undefined = (globalThis as any)?.process?.env?.AOE_REGISTRY;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--remote' && args[i + 1]) remoteUrl = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
    else if (!args[i].startsWith('--')) file = args[i];
  }

  file = file ?? findPrimeFile();
  if (!file) {
    error('No .prime file found. Specify one: aoe publish <file.prime>');
    process.exit(1);
  }

  const filePath = resolve(file);
  if (!fileExists(filePath)) {
    error(`File not found: ${filePath}`);
    process.exit(1);
  }

  header(`Publishing ${bold(basename(filePath))}`);

  const source = await readFile(filePath);

  info('Running pre-publish checks...');

  // Required fields — match the actual `.prime` source format. Two forms:
  //   1. Declaration form:  `widget Stripe {` (kind is the leading keyword)
  //   2. Object form:       `kind: widget` field inside an object body
  const id = source.match(/^\s*id\s*:\s*"([^"]+)"/m)?.[1];
  const name = source.match(/^\s*name\s*:\s*"([^"]+)"/m)?.[1] ?? id;
  const version = source.match(/^\s*version\s*:\s*"([^"]+)"/m)?.[1];
  // Try declaration form first
  let kind = source.match(/^([a-z][\w-]*)\s+\w+\s*\{/m)?.[1];
  if (!kind) kind = source.match(/^\s*kind\s*:\s*([\w-]+)/m)?.[1];

  if (!id) { error('Missing id field (e.g. id: "@scope/kind-slug")'); process.exit(1); }
  if (!version) { error('Missing version field'); process.exit(1); }
  if (!kind) { error('Missing kind (declaration `<kind> Name {` or `kind: <kind>` field)'); process.exit(1); }

  success(`id:      ${id}`);
  success(`version: ${version}`);
  success(`kind:    ${kind}`);
  if (name && name !== id) success(`name:    ${name}`);

  if (dryRun) {
    console.log();
    info(`Dry-run. To actually publish: drop --dry-run and pass --remote <url> (or set AOE_REGISTRY).`);
    return;
  }

  if (!remoteUrl) {
    console.log();
    error('No registry URL configured.');
    info('Pass  --remote https://registry.example.com  or set AOE_REGISTRY env var.');
    info('To smoke-test locally:  bun scripts/registry-server.ts  (defaults to http://localhost:7700)');
    process.exit(1);
  }

  const base = remoteUrl.replace(/\/$/, '');
  const url = base.endsWith('/atoms') ? `${base}/${id}.prime` : `${base}/atoms/${id}.prime`;
  const token = (globalThis as any)?.process?.env?.AOE_REGISTRY_TOKEN;

  console.log();
  const publishSpinner = createSpinner(`PUT ${url}`);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers,
      body: source,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    publishSpinner.stop(`${green('✅')} Published!`);
    console.log();
    success(`${bold(id)}@${version} now resolvable at ${url}`);
    console.log(`  ${gray(`Try:  aoe install ${id} --remote ${base}`)}`);
  } catch (e) {
    publishSpinner.stop();
    error(`Failed to publish: ${(e as Error).message}`);
    if (!token) info('Set AOE_REGISTRY_TOKEN to authenticate.');
    process.exit(1);
  }
}

function findPrimeFile(): string | null {
  const { readdirSync } = require('fs');
  const files = readdirSync('.').filter((f: string) => f.endsWith('.prime'));
  if (files.length === 1) return files[0];
  if (files.length > 1) {
    console.error(`Multiple .prime files found. Specify one: aoe publish <file>`);
    process.exit(1);
  }
  return null;
}
