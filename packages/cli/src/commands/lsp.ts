/**
 * aoe lsp — drive the AOE Language Server from the command line.
 *
 * ## Why this exists
 *
 * `@skill-wiki/language-server` implements §14.1's first four capabilities
 * (incremental document store, syntax diagnostics, model/schema diagnostics,
 * type/field completion) and until now **nothing in the workspace imported it**.
 * The package-wiring gate reported it as 949 unreached lines across 7 modules,
 * which is the correct reading: a library no invocable package reaches cannot
 * affect anything, however well tested it is. This command is the wiring — the
 * one production consumer that makes the server reachable from `bin.prime`.
 *
 * ## Boundary (ADR-8, plan §2.4 / §14 / §18.5): LSP is Toolchain
 *
 * The language server reuses Parser, Model Resolver and Checker and **does not
 * compile a production bundle**. This command inherits that boundary and must
 * keep it: it imports only `@skill-wiki/language-server`, writes no artifact,
 * and has no `--emit`/`--out` of any kind. Anything that would produce a runtime
 * bundle belongs to `aoe compile`, not here. `packages/language-server/test/
 * boundary.test.ts` asserts the server half; the import list below is the CLI
 * half — adding `@skill-wiki/compiler` here would breach it.
 *
 * ## Subcommands
 *
 *   aoe lsp diagnostics <file...> [--model <dir>]
 *       Open each file in the server and print exactly what an editor would
 *       show: the `compile` set (equal to the CLI's, §16 Phase 5) and the
 *       LSP-only `model` set, kept apart because the parity claim is about the
 *       former only. Exit 1 if any error-severity diagnostic is reported.
 *
 *   aoe lsp completion <file> --at <line>:<character> [--model <dir>]
 *       Print the completion items the server offers at a position, plus the
 *       completion context it resolved. Positions are 1-based on the command
 *       line (what an editor's status bar shows) and converted once, here.
 *
 * `diagnostics` is the default subcommand, so `aoe lsp a.prime` works.
 */

import { resolve } from 'path';
import { createLanguageServer, type LspDiagnostic } from '@skill-wiki/language-server';
import { header, success, error, info, warn, diagnosticLine, bold, gray, green, red, yellow } from '../utils/display';
import { readFile, fileExists } from '../utils/fs';

/** `--model <dir>` or `--model=<dir>`, both spellings, since both appear in the CLI already. */
function option(args: string[], name: string): string | undefined {
  const exact = args.indexOf(`--${name}`);
  if (exact >= 0 && args[exact + 1] !== undefined && !args[exact + 1]!.startsWith('--')) return args[exact + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline === undefined ? undefined : inline.slice(`--${name}=`.length);
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith('--')) {
      // `--model <dir>` consumes its value; `--model=<dir>` does not.
      if (!arg.includes('=') && args[i + 1] !== undefined && !args[i + 1]!.startsWith('--')) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

const LEVEL_OF_SEVERITY = { error: 'error', warning: 'warn', hint: 'suggestion' } as const;

/** The server reports 0-based LSP positions; humans and editors count from 1. */
function report(diagnostics: readonly LspDiagnostic[]) {
  for (const d of diagnostics) {
    const where = d.range.start.line + 1;
    const tag = d.code === undefined ? d.stage : `${d.stage}/${d.code}`;
    diagnosticLine(LEVEL_OF_SEVERITY[d.severity], where, `${gray(`[${tag}]`)} ${d.message}`, d.suggestion);
  }
}

async function diagnosticsSubcommand(args: string[]): Promise<number> {
  const files = positionals(args);
  if (files.length === 0) {
    console.error('Usage: aoe lsp diagnostics <file...> [--model <dir>]');
    return 1;
  }

  const modelRoot = option(args, 'model');
  // One server for all files: the point of a document store is that it is shared,
  // and the model package is loaded once rather than once per file.
  const server = createLanguageServer(modelRoot === undefined ? {} : { modelRoot: resolve(modelRoot) });

  header('AOE Language Server — diagnostics');
  if (server.model.kind === 'none') {
    info('No model package configured (--model <dir>): syntax diagnostics only, no model checks.');
  } else if (server.model.kind === 'invalid') {
    warn(`Model package at ${server.model.root} failed to load; model checks will be skipped.`);
    for (const d of server.model.diagnostics) console.log(`      ${red('•')} ${d.code}: ${d.message}`);
  }

  let errors = 0;
  let warnings = 0;
  for (const file of files) {
    const path = resolve(file);
    if (!fileExists(path)) {
      error(`File not found: ${path}`);
      errors += 1;
      continue;
    }
    const uri = `file://${path}`;
    server.openDocument(uri, await readFile(path));
    const { compile, model, compileOutcome, modelOutcome } = server.diagnostics(uri);

    console.log(`\n  ${bold(file)}`);
    const aborted = compileOutcome.kind === 'ran' ? compileOutcome.abortedAt : undefined;
    console.log(
      `    ${gray('compile')} ${
        compileOutcome.kind === 'not-applicable'
          ? gray(`skipped (${compileOutcome.reason})`)
          : aborted === undefined
            ? gray('ran all stages')
            : gray(`aborted at ${aborted}`)
      }`,
    );
    report(compile);
    console.log(
      `    ${gray('model')} ${
        modelOutcome.kind === 'checked' ? gray(`checked against ${modelOutcome.typeName}`) : gray(`skipped (${modelOutcome.reason})`)
      }`,
    );
    report(model);

    // Closed so a large multi-file run does not retain every parse; the store is
    // incremental for an editor session, not a batch cache.
    server.closeDocument(uri);
    for (const d of [...compile, ...model]) {
      if (d.severity === 'error') errors += 1;
      else if (d.severity === 'warning') warnings += 1;
    }
  }

  console.log('');
  if (errors > 0) console.log(`  ${red('❌')} ${errors} error(s), ${warnings} warning(s) across ${files.length} document(s)`);
  else if (warnings > 0) console.log(`  ${yellow('⚠️')} 0 errors, ${warnings} warning(s) across ${files.length} document(s)`);
  else console.log(`  ${green('✅')} No diagnostics across ${files.length} document(s)`);
  return errors > 0 ? 1 : 0;
}

async function completionSubcommand(args: string[]): Promise<number> {
  const [file] = positionals(args);
  const at = option(args, 'at');
  if (file === undefined || at === undefined) {
    console.error('Usage: aoe lsp completion <file> --at <line>:<character> [--model <dir>]');
    return 1;
  }
  const [lineText, characterText] = at.split(':');
  const line = Number(lineText);
  const character = Number(characterText);
  if (!Number.isInteger(line) || !Number.isInteger(character) || line < 1 || character < 1) {
    console.error(`--at must be <line>:<character>, both 1-based integers; got ${at}`);
    return 1;
  }

  const path = resolve(file);
  if (!fileExists(path)) {
    error(`File not found: ${path}`);
    return 1;
  }

  const modelRoot = option(args, 'model');
  const server = createLanguageServer(modelRoot === undefined ? {} : { modelRoot: resolve(modelRoot) });
  const uri = `file://${path}`;
  server.openDocument(uri, await readFile(path));
  const { items, context } = server.completion(uri, { line: line - 1, character: character - 1 });

  header(`AOE Language Server — completion at ${line}:${character}`);
  console.log(`  ${gray('context')} ${context.kind}`);
  if (server.model.kind !== 'loaded') {
    // Empty is the honest answer here, not a fallback list: completion items come
    // from the model package, never from names built into the toolchain (§3.1).
    info('No loaded model package, so there is nothing to complete from. Pass --model <dir>.');
    return 0;
  }
  if (items.length === 0) {
    info('No completion items at this position.');
    return 0;
  }
  for (const item of items) {
    console.log(`  ${green('•')} ${bold(item.label)} ${gray(`(${item.kind})`)} — ${item.detail}`);
    if (item.documentation !== undefined) console.log(`      ${gray(item.documentation)}`);
  }
  success(`${items.length} item(s)`);
  return 0;
}

export async function lspCommand(args: string[]): Promise<number> {
  const first = args[0];
  switch (first) {
    case 'completion':
      return completionSubcommand(args.slice(1));
    case 'diagnostics':
      return diagnosticsSubcommand(args.slice(1));
    case '--help':
    case '-h':
    case undefined:
      console.log(`
Usage: aoe lsp <subcommand> [options]

  diagnostics <file...>   Print the diagnostics an editor would show (default)
  completion <file>       Print completion items at a position

Options:
  --model <dir>           Model Package to check and complete against
  --at <line>:<char>      Cursor position for \`completion\`, 1-based

LSP is Toolchain (plan §2.4/§14): this command emits no artifact and never
compiles a production bundle. Use \`aoe compile\` for that.
`);
      return first === undefined ? 1 : 0;
    default:
      // `aoe lsp a.prime` — diagnostics is the default subcommand.
      return diagnosticsSubcommand(args);
  }
}
