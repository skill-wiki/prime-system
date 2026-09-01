#!/usr/bin/env bun

/**
 * AOE CLI for Agent Ontology Engine packages.
 *
 * Commands:
 *   aoe init                      Create a new .prime file interactively
 *   aoe compile <file>          Compile .prime → .md (with AI checks)
 *   aoe check <file>            Check without emitting
 *   aoe check --registry        Validate all atoms (semver + ref integrity)
 *   aoe test <file>             Run evaluation criteria tests
 *   aoe graph <file>            Visualize relationship graph
 *   aoe decompose <SKILL.md>    AI-assisted decomposition of Skill → Primes
 *   aoe compose --name <name>   Compose Primes into a new Skill
 *   aoe list [--scope @s]       List all atoms in local registry
 *   aoe show <@scope/name>      Print atom details + deps
 *   aoe deps <@scope/name>      Recursively walk dependency graph
 *   aoe install <@scope/name>   Resolve + verify atom deps locally
 *   aoe install <name>          Install a package release
 *   aoe install                 Install all Primes declared in SKILL.md
 *   aoe publish                 Publish to prime.dev
 *   aoe publish-marketplace     Open a PR to add this corpus to skill-wiki marketplace
 *   aoe search <query>          Search the registry
 *   aoe info <name>             View package details
 *   aoe ls                      List installed Primes (.primes/ dir)
 *   aoe action preflight|run    Plan or execute a side-effect-free audit Action
 *   aoe run inspect|replay      Read or fold back an Action run's append-only log
 *   aoe lsp diagnostics <file>  Editor-time diagnostics via the Language Server
 *   aoe lsp completion <file>   Completion items at a position
 */

import { compileCommand } from './commands/compile';
import { initCommand } from './commands/init';
import { checkCommand } from './commands/check';
import { checkRegistryCommand } from './commands/check-registry';
import { listCommand } from './commands/list';
import { showCommand } from './commands/show';
import { depsCommand } from './commands/deps';
import { installCommand as installCommandV2 } from './commands/install-v2';
import { installCommand } from './commands/install';
import { searchCommand } from './commands/search';
import { publishCommand } from './commands/publish';
import { publishMarketplaceCommand } from './commands/publish-marketplace';
import { lsCommand } from './commands/ls';
import { graphCommand } from './commands/graph';
import { decomposeCommand } from './commands/decompose';
import { composeCommand } from './commands/compose';
import { testCommand } from './commands/test';
import { infoCommand } from './commands/info';
import { doctorCommand } from './commands/doctor';
import { actionCommand } from './commands/action';
import { runCommand } from './commands/run';
import { lspCommand } from './commands/lsp';

const VERSION = '0.2.0';

function printUsage() {
  console.log(`
AOE v${VERSION} — Agent Ontology Engine for domain-aware applications

Usage: aoe <command> [options]

Core:
  init                    Create a new .prime file
  compile <file>          Compile .prime → .md
  compile <file> --deep   Compile with domain-level checks
  check <file>            Check without emitting output
  test <file>             Run evaluation criteria tests
  graph <file>            Visualize relationship graph

Decompose & Compose:
  decompose <SKILL.md>    AI-assisted Skill → Primes decomposition
  compose --name <name>   Compose Primes into a new Skill

Registry (local):
  list [--scope @s]       List all atoms in local registry
  show <@scope/name>      Print atom details + dep refs
  deps <@scope/name>      Walk dep graph as a tree
  install <@scope/name>   Resolve atom + verify all deps locally

Package Management:
  install [name]          Install package releases from a registry
  publish                 Publish a package release
  publish-marketplace     Submit corpus to skill-wiki marketplace via GitHub PR
  search <query>          Search the registry
  info <name>             View package details
  ls                      List installed Primes (.primes/)
  doctor [--dir <path>]   Inspect a compiled corpus bundle

Actions & Runs:
  action preflight        Plan an audit Action without invoking a provider
  action run              Execute a side-effect-free audit Action
  run inspect <runId>     Print a run's status and event log
  run replay <runId>      Fold a run back out of its append-only log

Editor Toolchain:
  lsp diagnostics <file>  Diagnostics an editor would show (Language Server)
  lsp completion <file>   Completion items at --at <line>:<char>

Options:
  --version, -v           Show version
  --help, -h              Show this help
  `);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`AOE v${VERSION}`);
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  try {
    switch (command) {
      case 'init':
        await initCommand(commandArgs);
        break;
      case 'compile':
        await compileCommand(commandArgs);
        break;
      case 'check':
        if (commandArgs.includes('--registry')) {
          await checkRegistryCommand(commandArgs);
        } else {
          await checkCommand(commandArgs);
        }
        break;
      case 'test':
        await testCommand(commandArgs);
        break;
      case 'graph':
        await graphCommand(commandArgs);
        break;
      case 'decompose':
        await decomposeCommand(commandArgs);
        break;
      case 'compose':
        await composeCommand(commandArgs);
        break;
      case 'list':
        await listCommand(commandArgs);
        break;
      case 'show':
        await showCommand(commandArgs);
        break;
      case 'deps':
        await depsCommand(commandArgs);
        break;
      case 'install':
        // If the first real arg is @scoped, use the new local resolver
        if (commandArgs.find(a => a.startsWith('@'))) {
          await installCommandV2(commandArgs);
        } else {
          await installCommand(commandArgs);
        }
        break;
      case 'publish':
        await publishCommand(commandArgs);
        break;
      case 'publish-marketplace':
      case 'marketplace-publish':
        await publishMarketplaceCommand(commandArgs);
        break;
      case 'search':
        await searchCommand(commandArgs);
        break;
      case 'info':
        await infoCommand(commandArgs);
        break;
      case 'ls':
        await lsCommand(commandArgs);
        break;
      case 'doctor': {
        const exitCode = doctorCommand(commandArgs);
        if (exitCode !== 0) process.exitCode = exitCode;
        break;
      }
      case 'action': {
        const exitCode = await actionCommand(commandArgs);
        if (exitCode !== 0) process.exitCode = exitCode;
        break;
      }
      case 'run': {
        const exitCode = runCommand(commandArgs);
        if (exitCode !== 0) process.exitCode = exitCode;
        break;
      }
      case 'lsp': {
        const exitCode = await lspCommand(commandArgs);
        if (exitCode !== 0) process.exitCode = exitCode;
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
