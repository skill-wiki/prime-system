/**
 * `prime run inspect|replay` — plan §11.4's run surface.
 *
 * `inspect` reads the append-only log a past run wrote. `replay` folds the run
 * back out of that log *without* touching the store's identity cache, and reports
 * whether the folded state is byte-equivalent to what was written — which is the
 * only way "同一 Snapshot + 输入可以重放" (§16 Phase 4 acceptance) can be checked
 * rather than asserted.
 *
 * Both take `--model` and `--corpus` because a runId alone does not address a run:
 * §12.4 files runs under (tenant, workspace, snapshot), and the snapshot id is
 * re-derived from those two artifacts. Accepting a bare runId would be the
 * cross-tenant read the scope rule exists to prevent.
 */

import { resolve as resolvePath } from 'path';
import { error, gray, header, success, warn, yellow } from '../utils/display';
import { openRunLog } from '../audit/assemble';

interface RunFlags {
  readonly sub: string;
  readonly runId?: string;
  readonly model?: string;
  readonly corpus?: string;
  readonly stateDir?: string;
  readonly tenant?: string;
  readonly workspace?: string;
  readonly json?: boolean;
}

const USAGE = `Usage:
  prime run inspect <runId> --model <dir> --corpus <dir> [options]
  prime run replay  <runId> --model <dir> --corpus <dir> [options]

Options
  --state-dir <dir>                Run log location (default: <corpus>.prime-runs, a sibling)
  --tenant <id> --workspace <id>   Scope the run was filed under (default: "default")
  --json                           Machine-readable output`;

function parseFlags(args: readonly string[]): RunFlags {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const named = new Map<string, keyof RunFlags>([
    ['--model', 'model'], ['--corpus', 'corpus'], ['--state-dir', 'stateDir'],
    ['--tenant', 'tenant'], ['--workspace', 'workspace'],
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const key = named.get(arg);
    if (key && args[i + 1] !== undefined) { flags[key] = args[++i]!; continue; }
    if (arg === '--json') { flags.json = true; continue; }
    if (!arg.startsWith('-')) positional.push(arg);
  }
  return { ...(flags as Omit<RunFlags, 'sub'>), sub: positional[0] ?? '', ...(positional[1] ? { runId: positional[1] } : {}) };
}

export function runCommand(args: string[]): number {
  const flags = parseFlags(args);
  if ((flags.sub !== 'inspect' && flags.sub !== 'replay') || !flags.runId || !flags.model || !flags.corpus) {
    console.error(USAGE);
    return 1;
  }
  let log: ReturnType<typeof openRunLog> | undefined;
  try {
    log = openRunLog({
      modelRoot: resolvePath(flags.model),
      corpusRoot: resolvePath(flags.corpus),
      tenant: flags.tenant ?? 'default',
      workspace: flags.workspace ?? 'default',
      ...(flags.stateDir ? { stateDir: resolvePath(flags.stateDir) } : {}),
    });
    const scoped = log.store.scoped(log.scope);
    const runId = flags.runId;
    const events = scoped.events(runId);
    if (events.length === 0) {
      error(`No run ${runId} in ${log.storePath} under scope ${JSON.stringify(log.scope)}`);
      return 1;
    }

    if (flags.sub === 'inspect') {
      const run = scoped.get(runId);
      if (flags.json) { console.log(JSON.stringify({ scope: log.scope, run, events }, null, 2)); return 0; }
      header(`Run ${runId}`);
      console.log(gray(`  scope    ${log.scope.tenant}/${log.scope.workspace}/${log.scope.snapshot}`));
      console.log(`  action   ${run?.action ?? '(unknown)'}`);
      console.log(`  status   ${run?.status ?? '(unknown)'}`);
      console.log(`  attempts ${String(run?.attempts ?? 0)}`);
      console.log();
      for (const event of events) {
        console.log(`  ${gray(String(event.sequence).padStart(3))} ${event.type}`);
      }
      return 0;
    }

    const replayed = log.store.replay(runId, log.scope);
    const equivalence = log.store.replayEquivalence(runId, log.scope);
    if (flags.json) {
      console.log(JSON.stringify({
        scope: log.scope, runId,
        revisions: replayed.revisions.length,
        events: replayed.events.length,
        lossy: replayed.lossy,
        run: replayed.run,
        equivalence,
      }, null, 2));
      return replayed.run === undefined ? 1 : 0;
    }
    header(`Replay ${runId}`);
    console.log(gray(`  scope    ${log.scope.tenant}/${log.scope.workspace}/${log.scope.snapshot}`));
    console.log(`  revisions ${String(replayed.revisions.length)}, events ${String(replayed.events.length)}`);
    if (replayed.run === undefined) {
      error('The log holds no run revision, so nothing could be folded.');
      return 1;
    }
    console.log(`  folded    action ${replayed.run.action}, status ${replayed.run.status}`);
    // `lossy` is a declared degradation, not a bug: a run carrying values JSON
    // cannot represent is stored with markers, and saying so is the point.
    if (replayed.lossy) warn('At least one revision was stored lossily; the folded run is not byte-equal by design.');
    if (equivalence.equivalent) success('Folded state is byte-equivalent to the stored revision.');
    else if (equivalence.live === undefined) console.log(yellow('  No live object in this process to compare against (expected across a restart).'));
    else error('Folded state differs from the stored revision.');
    console.log(gray(`  run log ${log.storePath}`));
    return 0;
  } catch (err) {
    error((err as Error).message);
    return 1;
  } finally {
    log?.close();
  }
}
