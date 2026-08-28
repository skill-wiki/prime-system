/**
 * Structured conformance results.
 *
 * Conformance must be reportable, not merely throwable: a gate needs to know
 * which checks were skipped for lack of capability versus which actually
 * failed, otherwise §17.5's "skip must be recorded, never disguised as pass"
 * cannot be enforced.
 */

export type Severity = "error" | "warning" | "info";
export type CheckStatus = "pass" | "fail" | "skip";

export interface Finding {
  /** Machine-stable code. Callers gate on this, never on `message`. */
  readonly code: string;
  readonly message: string;
  readonly severity: Severity;
  /** Filesystem path or logical location the finding is about. */
  readonly path?: string;
  /** The definition / unit / harness capability the finding is about. */
  readonly subject?: string;
}

export interface CheckOutcome {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** Present on `skip`: why the check could not run. */
  readonly skipReason?: string;
  readonly findings: readonly Finding[];
}

export interface SuiteCounts {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
}

export interface SuiteReport {
  readonly suite: string;
  /** What was audited: a model root, a corpus id, a harness name. */
  readonly subject: string;
  readonly status: CheckStatus;
  readonly checks: readonly CheckOutcome[];
  readonly counts: SuiteCounts;
  readonly errorCount: number;
  readonly warningCount: number;
}

export function finding(
  code: string,
  message: string,
  severity: Severity = "error",
  extra: { readonly path?: string; readonly subject?: string } = {},
): Finding {
  return { code, message, severity, ...extra };
}

/** A check fails when it produced at least one `error`; warnings alone pass. */
export function check(id: string, title: string, findings: readonly Finding[]): CheckOutcome {
  const failed = findings.some(f => f.severity === "error");
  return { id, title, status: failed ? "fail" : "pass", findings };
}

export function skipped(id: string, title: string, skipReason: string): CheckOutcome {
  return { id, title, status: "skip", skipReason, findings: [] };
}

export function report(suite: string, subject: string, checks: readonly CheckOutcome[]): SuiteReport {
  const counts: SuiteCounts = {
    pass: checks.filter(c => c.status === "pass").length,
    fail: checks.filter(c => c.status === "fail").length,
    skip: checks.filter(c => c.status === "skip").length,
  };
  const all = checks.flatMap(c => c.findings);
  return {
    suite,
    subject,
    status: counts.fail > 0 ? "fail" : counts.pass > 0 ? "pass" : "skip",
    checks,
    counts,
    errorCount: all.filter(f => f.severity === "error").length,
    warningCount: all.filter(f => f.severity === "warning").length,
  };
}

/** Deterministic, diff-friendly rendering for CI logs and lane reports. */
export function formatReport(r: SuiteReport): string {
  const lines: string[] = [
    `${r.suite} :: ${r.subject}`,
    `  status=${r.status} pass=${r.counts.pass} fail=${r.counts.fail} skip=${r.counts.skip} errors=${r.errorCount} warnings=${r.warningCount}`,
  ];
  for (const c of r.checks) {
    lines.push(`  [${c.status.toUpperCase()}] ${c.id} — ${c.title}${c.skipReason ? ` (skip: ${c.skipReason})` : ""}`);
    for (const f of c.findings) {
      const where = [f.subject, f.path].filter(Boolean).join(" @ ");
      lines.push(`      ${f.severity}/${f.code}${where ? ` [${where}]` : ""}: ${f.message}`);
    }
  }
  return lines.join("\n");
}
