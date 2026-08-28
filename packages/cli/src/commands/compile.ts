/**
 * prime compile <file.prime> [--deep] [--output <dir>] [--bundle] [--dir]
 *
 * This command owns argument parsing and presentation ONLY. The compile stage
 * sequence lives behind a single compiler entry point (`compileSource`, plan
 * §8.1) so that a CLI, a script and an MCP tool cannot drift into three
 * differently-ordered pipelines.
 */

import { resolve as resolvePath, basename, join } from 'path';
import { header, success, error, warn, info, diagnosticLine, createSpinner, bold, green, yellow, red, gray } from '../utils/display';
import { fileExists } from '../utils/fs';

import { compileSource, type PipelinePhaseEvent } from '@skill-wiki/compiler';

const PHASE_LABEL: Record<PipelinePhaseEvent['phase'], string> = {
  parse: 'Phase 1: Parsing...',
  check: 'Phase 2: Checking...',
  resolve: 'Phase 3: Resolving dependencies...',
  emit: 'Phase 4: Emitting...',
};

const PHASE_NUMBER: Record<PipelinePhaseEvent['phase'], number> = {
  parse: 1,
  check: 2,
  resolve: 3,
  emit: 4,
};

export async function compileCommand(args: string[]) {
  const flags = parseFlags(args);

  if (!flags.file) {
    console.error('Usage: prime compile <file.prime> [--deep] [--output <dir>] [--bundle]');
    process.exit(1);
  }

  const filePath = resolvePath(flags.file);
  if (!fileExists(filePath)) {
    error(`File not found: ${filePath}`);
    process.exit(1);
  }

  header(`Prime Compiler v0.1`);
  console.log(gray(`  Compiling: ${basename(filePath)}`));
  console.log();

  // One spinner per phase, driven by the pipeline's own progress events. The
  // CLI reacts to the sequence; it no longer defines it.
  let spinner: { stop: (message: string) => void } | undefined;
  const onPhase = (event: PipelinePhaseEvent) => {
    spinner?.stop(
      `${event.ok ? green('✅') : red('❌')} Phase ${PHASE_NUMBER[event.phase]}: ${event.detail}`,
    );
    spinner = undefined;
  };

  const startPhase = (phase: PipelinePhaseEvent['phase']) => createSpinner(PHASE_LABEL[phase]);

  spinner = startPhase('parse');
  const result = compileSource({
    file: filePath,
    level: flags.deep ? 3 : flags.structureOnly ? 1 : 2,
    ...(flags.output ? { outputDir: flags.output } : {}),
    bundle: Boolean(flags.bundle),
    emit: flags.dir ? 'atom-dir' : 'markdown',
    onPhase: (event) => {
      onPhase(event);
      const next: Record<PipelinePhaseEvent['phase'], PipelinePhaseEvent['phase'] | undefined> = {
        parse: 'check', check: 'resolve', resolve: 'emit', emit: undefined,
      };
      const upcoming = event.ok ? next[event.phase] : undefined;
      if (upcoming) spinner = startPhase(upcoming);
    },
  });
  spinner?.stop('');

  for (const diagnostic of result.diagnostics) {
    diagnosticLine(diagnostic.level, diagnostic.line, diagnostic.message, diagnostic.suggestion);
  }

  // Plan §17.5 — an optional check that did not run is reported, never silently
  // treated as a pass. This replaces the commented-out L2/L3 call sites.
  for (const stage of result.skipped) {
    warn(`${stage.stage} skipped — ${stage.reason}`);
  }

  if (!result.ok) {
    console.log();
    const errorCount = result.diagnostics.filter((d) => d.level === 'error').length;
    error(`${errorCount} error(s) in phase '${result.failedPhase}'. Fix and re-compile.`);
    process.exit(1);
  }

  console.log();
  if (result.emit === 'atom-dir') {
    if (result.atomDirSkipped) {
      info(`Skipped (content unchanged): ${result.atomId}`);
    } else {
      success(`${bold(result.atomOutDir ?? result.outputDir)}`);
      for (const file of result.files) {
        console.log(gray(`    → ${file}`));
      }
      success(`${join(result.outputDir, '_index.xml')}`);
    }
    console.log();
    const tokens = result.tokens ?? {};
    console.log(`  Tokens: summary=${tokens.summary ?? 0} core=${tokens.core ?? 0} full=${tokens.full ?? 0}`);
  } else {
    const compiledTokens = result.tokens?.compiled ?? 0;
    for (const [index, file] of result.files.entries()) {
      if (index === 0) success(`${bold(file)} (${compiledTokens} tokens, ${result.reductionPercent ?? 0}% reduction)`);
      else success(file);
    }
  }

  const errorCount = result.diagnostics.filter((d) => d.level === 'error').length;
  const warningCount = result.diagnostics.filter((d) => d.level === 'warn').length;
  const suggestionCount = result.diagnostics.filter((d) => d.level === 'suggestion').length;

  console.log();
  console.log(`  Result: ${green(`${errorCount} errors`)}, ${yellow(`${warningCount} warnings`)}, ${suggestionCount} suggestions. ${bold('Compilation successful.')}`);
}

// --- Internal helpers ---

interface CompileFlags {
  file?: string;
  deep?: boolean;
  structureOnly?: boolean;
  bundle?: boolean;
  dir?: boolean;
  output?: string;
}

function parseFlags(args: string[]): CompileFlags {
  const flags: CompileFlags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--deep') flags.deep = true;
    else if (arg === '--structure-only') flags.structureOnly = true;
    else if (arg === '--bundle') flags.bundle = true;
    else if (arg === '--dir') flags.dir = true;
    else if (arg === '--output' && args[i + 1]) { flags.output = args[++i]; }
    else if (!arg.startsWith('-')) flags.file = arg;
  }
  return flags;
}
