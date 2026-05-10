/**
 * prime publish-marketplace — Submit your compiled Prime corpus to the
 * Skill Wiki marketplace via an automated GitHub PR.
 *
 * What it does:
 *   1. Verifies cwd has a `pack.yaml` (Prime manifest) and a compiled output dir.
 *   2. Reads `pack.yaml` for name / version / description / compiled subdir.
 *   3. Detects the GitHub repo from `git remote get-url origin`.
 *   4. Confirms `gh auth status` is healthy.
 *   5. Forks `skill-wiki/skill-wiki.github.io` (or reuses an existing fork),
 *      clones it to a temp dir, appends a YAML entry to `data/skills.yaml`,
 *      validates the YAML still parses, branches, commits, pushes, and
 *      opens a PR via `gh pr create`.
 *
 * Use --dry-run to preview the YAML diff without forking / cloning / pushing.
 */

import { resolve, join, basename } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { header, success, error, info, warn, bold, gray, cyan, green } from '../utils/display';

const MARKETPLACE_REPO = 'skill-wiki/skill-wiki.github.io';
const SKILLS_YAML_PATH = 'data/skills.yaml';

interface PackManifest {
  name: string;
  version?: string;
  description?: string;
  compiled?: string;
  homepage?: string;
}

interface PublishOpts {
  description?: string;
  tags?: string[];
  repo?: string;          // owner/repo of the user's source repo
  homepage?: string;
  slug?: string;
  dryRun: boolean;
}

export async function publishMarketplaceCommand(args: string[]) {
  const opts = parseArgs(args);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  header('Publish to Skill Wiki marketplace');

  // ── 1. Locate pack.yaml ──
  const cwd = process.cwd();
  const packPath = join(cwd, 'pack.yaml');
  if (!existsSync(packPath)) {
    error(`No pack.yaml found in ${cwd}`);
    info('Run this command from the root of your Prime corpus repo.');
    info('A minimal pack.yaml needs `name`, `version`, `description`, `compiled`.');
    process.exit(1);
  }
  const pack = parsePackYaml(readFileSync(packPath, 'utf8'));
  if (!pack.name) { error('pack.yaml is missing `name`.'); process.exit(1); }
  success(`Found pack.yaml — ${bold(pack.name)}${pack.version ? ` @ ${pack.version}` : ''}`);

  // ── 2. Verify compiled artifacts exist ──
  const compiledSubdir = pack.compiled || 'compiled';
  const compiledPath = join(cwd, compiledSubdir);
  if (!existsSync(compiledPath)) {
    error(`Compiled directory not found: ${compiledSubdir}/`);
    info(`Run \`prime compile\` (or \`bun scripts/build-atom-dirs.ts\`) first.`);
    process.exit(1);
  }
  const indexXml = join(compiledPath, '_index.xml');
  if (!existsSync(indexXml)) {
    warn(`${compiledSubdir}/_index.xml is missing — the marketplace renderer needs it.`);
    info('Re-run the compiler so it emits a corpus index.');
    process.exit(1);
  }
  success(`Compiled output OK — ${compiledSubdir}/_index.xml`);

  // ── 3. Detect source repo from git remote ──
  let userRepo = opts.repo;
  if (!userRepo) {
    const remote = sh('git', ['remote', 'get-url', 'origin'], { cwd });
    if (remote.status !== 0) {
      error('Could not read `git remote get-url origin`. Pass --repo <owner/repo>.');
      process.exit(1);
    }
    const detected = parseGitHubRepo(remote.stdout.trim());
    if (!detected) {
      error(`Origin remote is not on GitHub: ${remote.stdout.trim()}`);
      info('Pass --repo <owner/repo> explicitly, or push your corpus to GitHub first.');
      process.exit(1);
    }
    userRepo = detected;
  }
  success(`Source repo: ${bold(userRepo)}`);

  // ── 4. Build the YAML entry ──
  const slug = opts.slug || deriveSlug(pack.name);
  const description = (opts.description || pack.description || '').trim();
  const tags = opts.tags || [];
  const homepage = opts.homepage || pack.homepage || `https://github.com/${userRepo}`;

  // ── 5. gh auth check (skipped under --dry-run) ──
  let ghUser = 'YOUR-GITHUB-USERNAME';
  if (!opts.dryRun) {
    const auth = sh('gh', ['auth', 'status'], {});
    if (auth.status !== 0) {
      error('`gh` is not authenticated.');
      info('Run `gh auth login` first, then re-run this command.');
      info(auth.stderr.trim() || auth.stdout.trim());
      process.exit(1);
    }
    const who = sh('gh', ['api', 'user', '--jq', '.login'], {});
    if (who.status !== 0) {
      error('`gh api user` failed. Is your token valid?');
      process.exit(1);
    }
    ghUser = who.stdout.trim();
    success(`GitHub user: ${bold(ghUser)}`);
  } else {
    info('Dry-run mode — skipping `gh auth status` and `gh api user`.');
  }

  const entry = renderYamlEntry({
    slug,
    repo: userRepo,
    compiledSubdir,
    description,
    homepage,
    maintainers: [ghUser],
    tags,
  });

  console.log();
  console.log(bold('YAML entry to append to data/skills.yaml:'));
  console.log(gray('───────────────────────────────────────────'));
  console.log(entry);
  console.log(gray('───────────────────────────────────────────'));
  console.log();

  if (opts.dryRun) {
    info('Dry-run complete. To actually publish, drop --dry-run.');
    return;
  }

  // ── 6. Fork (idempotent) ──
  info(`Forking ${MARKETPLACE_REPO} (no-op if you already have a fork)…`);
  const fork = sh('gh', ['repo', 'fork', MARKETPLACE_REPO, '--remote=false', '--clone=false'], {});
  if (fork.status !== 0 && !/already exists/i.test(fork.stderr + fork.stdout)) {
    error(`gh repo fork failed: ${fork.stderr.trim() || fork.stdout.trim()}`);
    process.exit(1);
  }
  success('Fork ready.');

  // ── 7. Clone the fork to a temp dir ──
  const work = mkdtempSync(join(tmpdir(), 'skill-wiki-pr-'));
  const forkRepo = `${ghUser}/skill-wiki.github.io`;
  info(`Cloning ${forkRepo} → ${work}`);
  const clone = sh('gh', ['repo', 'clone', forkRepo, work, '--', '--depth', '1'], {});
  if (clone.status !== 0) {
    error(`gh repo clone failed: ${clone.stderr.trim() || clone.stdout.trim()}`);
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }

  // Make sure the fork is in sync with upstream main, otherwise the PR diff
  // can include unrelated commits.
  sh('git', ['remote', 'add', 'upstream', `https://github.com/${MARKETPLACE_REPO}.git`], { cwd: work });
  sh('git', ['fetch', 'upstream', 'main'], { cwd: work });
  sh('git', ['reset', '--hard', 'upstream/main'], { cwd: work });

  // ── 8. Append entry to data/skills.yaml ──
  const yamlPath = join(work, SKILLS_YAML_PATH);
  if (!existsSync(yamlPath)) {
    error(`${SKILLS_YAML_PATH} missing in the fork — repo layout changed?`);
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }
  const existing = readFileSync(yamlPath, 'utf8');
  if (existing.includes(`slug: ${slug}`)) {
    error(`An entry with slug "${slug}" already exists in data/skills.yaml.`);
    info('Either pick a different slug with --slug <slug>, or update the existing entry by hand.');
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }
  const updated = existing.replace(/\s*$/, '\n') + '\n' + entry + '\n';
  writeFileSync(yamlPath, updated);

  // ── 9. Lightweight YAML sanity check (regex-only — no new deps) ──
  if (!/^\s*-\s+slug:\s+/m.test(entry)) {
    error('Generated YAML entry failed shape check. Aborting.');
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }
  success(`Appended entry to data/skills.yaml`);

  // ── 10. Branch + commit + push + PR ──
  const branch = `add-${slug}`;
  sh('git', ['checkout', '-b', branch], { cwd: work });
  sh('git', ['add', SKILLS_YAML_PATH], { cwd: work });
  sh('git', ['commit', '-m', `marketplace: add ${pack.name}`], { cwd: work });
  const push = sh('git', ['push', '-u', 'origin', branch, '--force'], { cwd: work });
  if (push.status !== 0) {
    error(`git push failed: ${push.stderr.trim()}`);
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }

  const prBody = renderPrBody(pack, userRepo, slug);
  const pr = sh('gh', [
    'pr', 'create',
    '--repo', MARKETPLACE_REPO,
    '--head', `${ghUser}:${branch}`,
    '--base', 'main',
    '--title', `Add ${pack.name} to marketplace`,
    '--body', prBody,
  ], { cwd: work });

  if (pr.status !== 0) {
    error(`gh pr create failed: ${pr.stderr.trim() || pr.stdout.trim()}`);
    info(`Your branch is pushed at https://github.com/${forkRepo}/tree/${branch} — open a PR manually.`);
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }

  console.log();
  success(`PR opened: ${green(pr.stdout.trim())}`);
  rmSync(work, { recursive: true, force: true });
}

// ── helpers ──

function parseArgs(args: string[]): PublishOpts {
  const opts: PublishOpts = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--description' && args[i + 1]) opts.description = args[++i];
    else if (a === '--tags' && args[i + 1]) opts.tags = args[++i].split(',').map(t => t.trim()).filter(Boolean);
    else if (a === '--repo' && args[i + 1]) opts.repo = args[++i];
    else if (a === '--homepage' && args[i + 1]) opts.homepage = args[++i];
    else if (a === '--slug' && args[i + 1]) opts.slug = args[++i];
  }
  return opts;
}

function printHelp() {
  console.log(`
${bold('prime publish-marketplace')} — automate a PR to skill-wiki/skill-wiki.github.io

Usage:
  prime publish-marketplace [options]

Options:
  --description <text>   One-line marketplace card copy (defaults to pack.yaml description)
  --tags <a,b,c>         Comma-separated tag list
  --repo <owner/repo>    GitHub source repo (defaults to git remote origin)
  --homepage <url>       Card link target (defaults to https://github.com/<repo>)
  --slug <slug>          Marketplace slug (defaults to derived from pack name)
  --dry-run              Print the YAML entry that would be added; no fork / no push
  --help, -h             Show this help

Prerequisites:
  - \`pack.yaml\` and the compiled output directory must exist in the cwd
  - \`gh\` CLI must be installed and authenticated (\`gh auth login\`)
  - The cwd must be a git repo with a GitHub origin (or pass --repo)
`);
}

/**
 * Minimal pack.yaml reader. Only handles the keys we care about (top-level
 * scalars). We deliberately avoid pulling in js-yaml — the fields are flat.
 */
function parsePackYaml(src: string): PackManifest {
  const grab = (key: string): string | undefined => {
    const m = src.match(new RegExp(`^\\s*${key}\\s*:\\s*"?([^"\\n]+?)"?\\s*$`, 'm'));
    return m?.[1]?.trim();
  };
  return {
    name: grab('name') || '',
    version: grab('version'),
    description: grab('description'),
    compiled: grab('compiled'),
    homepage: grab('homepage'),
  };
}

function parseGitHubRepo(remote: string): string | null {
  // Handle SSH (git@github.com:owner/repo.git) and HTTPS forms.
  const ssh = remote.match(/git@github\.com:([^/]+)\/([^/.]+?)(\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = remote.match(/github\.com\/([^/]+)\/([^/.]+?)(\.git)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

function deriveSlug(name: string): string {
  // "@my/cooking" → "cooking" ; "@my/skill-foo" → "skill-foo"
  const stripped = name.replace(/^@/, '');
  const parts = stripped.split('/');
  return parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

function renderYamlEntry(p: {
  slug: string;
  repo: string;
  compiledSubdir: string;
  description: string;
  homepage: string;
  maintainers: string[];
  tags: string[];
}): string {
  const lines = [
    `  - slug: ${p.slug}`,
    `    repo: ${p.repo}`,
    `    compiledSubdir: ${p.compiledSubdir}`,
  ];
  if (p.description) {
    // Use block scalar so multi-line descriptions stay readable.
    lines.push(`    description: |`);
    for (const seg of wrap(p.description, 70)) lines.push(`      ${seg}`);
  }
  lines.push(`    homepage: ${p.homepage}`);
  lines.push(`    maintainers: [${p.maintainers.join(', ')}]`);
  if (p.tags.length) lines.push(`    tags: [${p.tags.join(', ')}]`);
  return lines.join('\n');
}

function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/);
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > w) {
      if (line) out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

function renderPrBody(pack: PackManifest, repo: string, slug: string): string {
  return `## Add \`${pack.name}\` to the Skill Wiki marketplace

- **Source repo:** https://github.com/${repo}
- **Slug:** \`${slug}\`
- **Version:** ${pack.version || 'unspecified'}

### Contribution checklist
- [x] Compiled output committed (\`_index.xml\` present)
- [x] Slug is unique within \`data/skills.yaml\`
- [x] Repo is public and readable by the marketplace builder
- [ ] Tags reviewed by the maintainer

Submitted via \`prime publish-marketplace\`.
`;
}

interface ShOpts { cwd?: string }
function sh(cmd: string, args: string[], opts: ShOpts) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' });
  return {
    status: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}
