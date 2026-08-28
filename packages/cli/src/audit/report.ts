/**
 * Step 5 of the plan §16 Phase 4 audit pipeline: **produce the report**.
 *
 * The report goes through `finalizeCorpusBundle` (`@skill-wiki/bundle`) rather
 * than a `writeFileSync` here, for one reason that is not convenience: an audit
 * record has to be immutable, digest-sealed and verified after the write, and
 * `finalizeCorpusBundle` is the only writer in this repo that does staging,
 * atomic rename, rollback-on-failure, symlink refusal, content+index digests and
 * a post-write `loadCorpusSnapshot` verification. Re-implementing that here would
 * duplicate a hardened 54-line module in order to produce a weaker artifact.
 *
 * What the report *is*, then, is a corpus of findings: one addressable entry per
 * check, sealed by the same manifest machinery that seals a compiled corpus. The
 * entry `kind` is the check's rule family — this engine's own taxonomy of checks,
 * not a model type name, because the findings are the engine's statements about
 * the model rather than instances of it.
 *
 * The write is performed by the CLI *after* the run's output has been validated,
 * never by the action's provider. The audit action declares `sideEffects: none`
 * and the provider honours that literally: it touches no filesystem.
 */

import type { BundleManifestMetadata, CorpusIndexEntry, FinalizedCorpusBundle } from '@skill-wiki/bundle';
import { finalizeCorpusBundle } from '@skill-wiki/bundle';
import type { AuditedCorpus } from './corpus';
import type { AuditFindings, CheckResult } from './checks';

export interface AuditReportOptions {
  readonly outDir: string;
  readonly findings: AuditFindings;
  readonly corpus: AuditedCorpus;
  readonly runId: string;
  readonly now?: () => Date;
}

/** Three renderings of one finding, deepest last. Their word counts become the entry's token costs. */
function renderings(result: CheckResult): readonly [string, string, string] {
  const state = result.skipped ? 'skipped' : result.satisfied ? 'satisfied' : 'violated';
  const summary = `${result.rule} ${state}`;
  const core = `${summary} — subject ${result.subject}, severity ${result.severity}`;
  const full = [
    core,
    `provider ${result.provider}`,
    `deterministic ${String(result.deterministic)}`,
    `confidence ${String(result.confidence)}`,
    `model ${result.modelVersion}`,
    ...(result.skipReason ? [`skipReason ${result.skipReason}`] : []),
    ...(result.detail ? [`detail ${result.detail}`] : []),
    ...result.evidence.map((item) => `evidence ${item}`),
  ].join('; ');
  return [summary, core, full];
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Zero-padded so the emitted index sorts in run order rather than lexical order of 1, 10, 2. */
function entryId(runId: string, index: number, total: number): string {
  return `${runId}/check-${String(index + 1).padStart(String(total).length, '0')}`;
}

export function auditReportEntries(findings: AuditFindings, runId: string): readonly CorpusIndexEntry[] {
  const total = findings.results.length;
  return findings.results.map((result, index) => {
    const [summary, core, full] = renderings(result);
    return {
      id: entryId(runId, index, total),
      kind: result.family,
      version: findings.model.version,
      description: summary,
      domain: findings.model.name,
      tags: [
        result.skipped ? 'skipped' : result.satisfied ? 'satisfied' : 'violated',
        `severity:${result.severity}`,
        `provider:${result.provider}`,
      ],
      tokens: { summary: words(summary), core: words(core), full: words(full) },
    };
  });
}

/**
 * Seal the findings into their own bundle.
 *
 * Every provenance field is copied from something that already recorded it: the
 * schema digest and the audited release come off the audited bundle's manifest,
 * and `sourceRevision` is the audited corpus's content digest, so the report
 * names the exact bytes it judged. `release` is the run id, because one audit run
 * produces exactly one immutable report.
 */
export function writeAuditReport(options: AuditReportOptions): FinalizedCorpusBundle {
  const { findings, corpus, runId } = options;
  const entries = auditReportEntries(findings, runId);
  if (entries.length === 0) {
    throw new Error('Audit produced no findings, so there is no report to seal.');
  }
  const manifest: BundleManifestMetadata = {
    protocolVersion: '2.0.0',
    irVersion: '2',
    compilerVersion: corpus.bundleSnapshot.compilerVersion,
    emitterVersion: corpus.bundleSnapshot.emitterVersion,
    corpus: `${findings.model.name}/audit`,
    release: runId,
    sourceRevision: corpus.bundleSnapshot.contentDigest,
    models: { [findings.model.name]: findings.model.version },
    schemaDigest: corpus.bundleSnapshot.schemaDigest,
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  };
  return finalizeCorpusBundle({ outDir: options.outDir, entries, manifest });
}
