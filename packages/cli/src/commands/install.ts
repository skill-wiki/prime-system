/**
 * aoe install [name[@version]] — Install a Prime from registry or install all from SKILL.md.
 */

import { resolve, join } from 'path';
import { header, success, error, info, createSpinner, bold, green } from '../utils/display';
import { ensurePrimesDir, readFile, writeFile, fileExists } from '../utils/fs';

const REGISTRY_URL = 'https://prime.dev/api';

export async function installCommand(args: string[]) {
  if (args.length === 0) {
    await installFromSkill();
  } else {
    await installSingle(args[0]);
  }
}

async function installSingle(nameVersion: string) {
  const [name, version] = nameVersion.split('@');

  header(`Installing ${bold(name)}${version ? `@${version}` : ''}`);

  const primesDir = ensurePrimesDir();
  const spinner = createSpinner(`Fetching ${name} from prime.dev...`);

  try {
    const url = version
      ? `${REGISTRY_URL}/primes/${name}/${version}/download`
      : `${REGISTRY_URL}/primes/${name}/download`;

    const response = await fetch(url);

    if (!response.ok) {
      spinner.stop();
      // Fallback: check if it's a local prime in the primes/ directory
      const localPath = resolve('primes', `${name}.prime`);
      if (fileExists(localPath)) {
        const source = await readFile(localPath);
        await writeFile(join(primesDir, 'source', `${name}.prime`), source);
        spinner.stop(`${green('✅')} Installed ${bold(name)} from local primes/`);
        return;
      }
      error(`Prime '${name}' not found on prime.dev or locally`);
      info(`Create it with: aoe init ${name}`);
      process.exit(1);
    }

    const data = await response.json() as any;

    // Save source and compiled versions
    if (data.source) {
      await writeFile(join(primesDir, 'source', `${name}.prime`), data.source);
    }
    if (data.compiled) {
      await writeFile(join(primesDir, 'compiled', `${name}.md`), data.compiled);
    }

    spinner.stop(`${green('✅')} Installed ${bold(name)}@${data.version || version || 'latest'}`);

    // Install dependencies
    if (data.dependencies && data.dependencies.length > 0) {
      info(`Installing ${data.dependencies.length} dependencies...`);
      for (const dep of data.dependencies) {
        await installSingle(typeof dep === 'string' ? dep : `${dep.name}@${dep.version}`);
      }
    }
  } catch (e) {
    spinner.stop();
    // Offline fallback: try local
    const localPath = resolve('primes', `${name}.prime`);
    if (fileExists(localPath)) {
      const source = await readFile(localPath);
      await writeFile(join(primesDir, 'source', `${name}.prime`), source);
      success(`Installed ${bold(name)} from local primes/ (registry unavailable)`);
    } else {
      error(`Failed to install '${name}': ${(e as Error).message}`);
      info('Check your network connection or use a local .prime file');
      process.exit(1);
    }
  }
}

async function installFromSkill() {
  const skillPath = resolve('SKILL.md');
  if (!fileExists(skillPath)) {
    error('No SKILL.md found in current directory.');
    info('Specify a Prime name: aoe install <name>');
    process.exit(1);
  }

  header('Installing Primes from SKILL.md');

  const content = await readFile(skillPath);
  const primesMatch = content.match(/primes:\s*\n((?:\s+-\s+.+\n?)+)/);

  if (!primesMatch) {
    info('No primes: section found in SKILL.md');
    process.exit(0);
  }

  const primeRefs = primesMatch[1]
    .split('\n')
    .map(l => l.replace(/^\s+-\s+/, '').trim())
    .filter(l => l.length > 0);

  console.log(`  Found ${primeRefs.length} Prime references\n`);

  for (const ref of primeRefs) {
    await installSingle(ref);
  }

  console.log();
  success(`All ${primeRefs.length} Primes installed.`);
}
