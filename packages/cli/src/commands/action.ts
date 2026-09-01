/**
 * `aoe action preflight|run` — plan §11.4's action surface, and the bin entry
 * that makes `@skill-wiki/action-runtime` and `@skill-wiki/event-store` reachable
 * from something that actually runs.
 *
 * Scope is deliberately the §16 Phase 4 use case and nothing more: a
 * side-effect-free audit (select rules -> load evidence -> run checks -> aggregate
 * -> report). `assembleAudit` refuses an action declaring an external write, so
 * this command cannot be talked into being the "generic workflow" Phase 4 warns
 * against building first.
 */

import { resolve as resolvePath } from 'path';
import { bold, error, gray, green, header, info, red, success, warn, yellow } from '../utils/display';
import { assembleAudit, auditContext, snapshotIdOf, AuditAssemblyError } from '../audit/assemble';
import { writeAuditReport } from '../audit/report';
import type { CheckResult } from '../audit/checks';

interface ActionFlags {
  readonly sub: string;
  readonly model?: string;
  readonly corpus?: string;
  readonly action?: string;
  readonly input?: string;
  readonly attestation?: string;
  readonly report?: string;
  readonly stateDir?: string;
  readonly principal?: string;
  readonly roles?: string;
  readonly capabilities?: string;
  readonly tenant?: string;
  readonly workspace?: string;
  readonly trace?: string;
  readonly key?: string;
  readonly json?: boolean;
}

const USAGE = `Usage:
  aoe action preflight --model <dir> --corpus <dir> --action <Name> [options]
  aoe action run       --model <dir> --corpus <dir> --action <Name> --key <idempotency-key> [options]

Required context (no defaults: an audit records who asked, not who the CLI guessed)
  --principal <id>            Principal the run is attributed to
  --capabilities <a,b>        Capabilities the principal holds

Options
  --input <json>              Action input object (default: {})
  --attestation <json>        Caller-declared fields for a model-typed output
  --report <dir>              Seal the findings into a bundle at <dir> (run only)
  --state-dir <dir>           Run log location (default: <corpus>.prime-runs, a sibling)
  --roles <a,b>               Principal roles
  --tenant <id> --workspace <id>   Multi-tenant scope (default: "default")
  --trace <id>                Trace id (default: derived from the run clock)
  --json                      Machine-readable output`;

function parseFlags(args: readonly string[]): ActionFlags {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const named = new Map<string, keyof ActionFlags>([
    ['--model', 'model'], ['--corpus', 'corpus'], ['--action', 'action'], ['--input', 'input'],
    ['--attestation', 'attestation'], ['--report', 'report'], ['--state-dir', 'stateDir'],
    ['--principal', 'principal'], ['--roles', 'roles'], ['--capabilities', 'capabilities'],
    ['--tenant', 'tenant'], ['--workspace', 'workspace'], ['--trace', 'trace'], ['--key', 'key'],
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const key = named.get(arg);
    if (key && args[i + 1] !== undefined) { flags[key] = args[++i]!; continue; }
    if (arg === '--json') { flags.json = true; continue; }
    if (!arg.startsWith('-')) positional.push(arg);
  }
  return { ...(flags as Omit<ActionFlags, 'sub'>), sub: positional[0] ?? '' };
}

function parseJsonObject(label: string, raw: string | undefined): Readonly<Record<string, unknown>> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new AuditAssemblyError(`${label} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuditAssemblyError(`${label} must be a JSON object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

const list = (raw: string | undefined): readonly string[] =>
  (raw ?? '').split(',').map((item) => item.trim()).filter(Boolean);

function requireFlag(value: string | undefined, name: string): string {
  if (!value) throw new AuditAssemblyError(`${name} is required`);
  return value;
}

function printFinding(result: CheckResult): void {
  const mark = result.skipped ? yellow('⊘') : result.satisfied ? green('✓') : red('✗');
  const tail = result.skipped ? gray(` skipped — ${result.skipReason ?? 'no reason recorded'}`)
    : result.satisfied ? '' : red(` — ${result.detail ?? 'violated'}`);
  console.log(`    ${mark} ${result.rule} ${gray(result.subject)}${tail}`);
}

export async function actionCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.sub !== 'preflight' && flags.sub !== 'run') {
    console.error(USAGE);
    return 1;
  }
  let assembled: ReturnType<typeof assembleAudit> | undefined;
  try {
    const modelRoot = resolvePath(requireFlag(flags.model, '--model'));
    const corpusRoot = resolvePath(requireFlag(flags.corpus, '--corpus'));
    const action = requireFlag(flags.action, '--action');
    const principal = requireFlag(flags.principal, '--principal');
    const input = parseJsonObject('--input', flags.input) ?? {};
    const attestation = parseJsonObject('--attestation', flags.attestation);
    const tenant = flags.tenant ?? 'default';
    const workspace = flags.workspace ?? 'default';
    assembled = assembleAudit({
      modelRoot,
      corpusRoot,
      action,
      tenant,
      workspace,
      ...(flags.stateDir ? { stateDir: resolvePath(flags.stateDir) } : {}),
      ...(attestation ? { attestation } : {}),
    });
    const context = auditContext({
      principal,
      roles: list(flags.roles),
      capabilities: list(flags.capabilities),
      trace: flags.trace ?? `trace-${Date.now()}`,
      snapshot: assembled.snapshot,
      tenant,
      workspace,
    });

    if (!flags.json) {
      header(`AOE Action — ${flags.sub}`);
      console.log(gray(`  model    ${assembled.model.manifest.name}@${assembled.model.manifest.version}`));
      console.log(gray(`  corpus   ${assembled.corpus.units.length} unit(s), ${assembled.corpus.edges.length} edge(s)`));
      console.log(gray(`  snapshot ${snapshotIdOf(assembled.snapshot)}`));
      for (const diagnostic of assembled.corpus.diagnostics) warn(`${diagnostic.code} — ${diagnostic.message}`);
      console.log();
    }

    if (flags.sub === 'preflight') {
      // §9.6: preflight authorizes and plans, and must never reach a provider.
      const effect = await assembled.runtime.preflight(action, input, context);
      if (flags.json) { console.log(JSON.stringify({ effect }, null, 2)); return 0; }
      success(`${bold(effect.action)} → provider ${effect.provider}`);
      console.log(`  sideEffects ${effect.sideEffects}, approval ${effect.approval}`);
      console.log(`  capabilities ${effect.requiredCapabilities.join(', ') || '(none)'}`);
      const decision = effect.authorizationDecision;
      console.log(`  authorization ${decision?.allowed ? green('allowed') : red('denied')} — ${decision?.reason ?? '(no decision)'}`);
      info('No provider was invoked.');
      return 0;
    }

    const key = requireFlag(flags.key, '--key');
    const run = await assembled.runtime.execute(action, input, context, key);
    const findings = assembled.provider.findings;
    const events = assembled.runtime.events(run.id);
    let reportPath: string | undefined;
    // The write is the CLI's, after the runtime validated the output. The audit
    // action itself declares no side effects and its provider performs no I/O.
    let reportError: string | undefined;
    if (flags.report && findings && run.status === 'succeeded') {
      // A failed *report* write must not erase a completed audit: the run is
      // already in the append-only log, and losing its findings because a
      // destination path was unusable would be the CLI destroying evidence.
      try {
        const sealed = writeAuditReport({
          outDir: resolvePath(flags.report),
          findings,
          corpus: assembled.corpus,
          runId: run.id,
        });
        reportPath = sealed.manifestPath;
        assembled.store.append(run.id, 'audit.report.sealed', {
          manifest: sealed.manifestPath,
          index: sealed.indexPath,
          contentDigest: sealed.manifest.contentDigest,
          findingsDigest: findings.digest,
        });
      } catch (err) {
        reportError = (err as Error).message;
        assembled.store.append(run.id, 'audit.report.failed', { error: reportError });
      }
    }

    if (flags.json) {
      console.log(JSON.stringify({
        runId: run.id, status: run.status, attempts: run.attempts, output: run.output,
        error: run.error, evidence: run.evidence, plan: run.plan,
        events: events.map((event) => ({ sequence: event.sequence, type: event.type })),
        findings, reportPath, reportError,
      }, null, 2));
      return run.status === 'succeeded' ? 0 : 1;
    }

    const ok = run.status === 'succeeded';
    (ok ? success : error)(`run ${run.id} — ${run.status}${run.error ? `: ${run.error}` : ''}`);
    console.log(`  plan     ${run.plan.nodes.length} node(s), ${run.plan.edges.length} edge(s), checkpoints ${run.plan.checkpoints.join(', ') || '(none)'}`);
    for (const diagnostic of run.plan.diagnostics ?? []) warn(`plan ${diagnostic.code} — ${diagnostic.message}`);
    const decision = run.authorizationDecision;
    console.log(`  authz    ${decision?.allowed ? green('allowed') : red('denied')} — ${decision?.reason ?? '(no decision)'}`);
    if (run.policyDecision) console.log(`  policy   ${run.policyDecision.allowed ? green('allowed') : red('denied')} — ${run.policyDecision.reason}`);
    console.log(`  events   ${events.map((event) => event.type).join(' → ')}`);
    if (findings) {
      const { total, passed, failed, skipped, score } = findings.metrics;
      console.log();
      console.log(`  ${bold('Findings')}  ${green(`${passed} passed`)}, ${red(`${failed} failed`)}, ${yellow(`${skipped} skipped`)} of ${total} (score ${score})`);
      console.log(gray(`  rules selected: ${findings.rules.length}; digest ${findings.digest}`));
      for (const result of findings.results.filter((r) => r.skipped || !r.satisfied)) printFinding(result);
    }
    if (reportPath) success(`report ${bold(reportPath)}`);
    if (reportError) warn(`report not sealed — ${reportError}`);
    console.log();
    console.log(gray(`  run log ${assembled.storePath}`));
    return ok ? 0 : 1;
  } catch (err) {
    error((err as Error).message);
    return 1;
  } finally {
    assembled?.close();
  }
}
