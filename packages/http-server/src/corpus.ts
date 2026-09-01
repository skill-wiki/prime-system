/**
 * @module corpus
 *
 * Traced corpus mount and release switch.
 *
 * `runtime`'s `CorpusRegistry` already owns mounting, duplicate rejection and
 * which release a namespace resolves to. This module adds exactly one thing:
 * spans and span events for those transitions, so a trace can answer "which
 * corpus release was serving when this query ran, and when did that last change".
 *
 * It sits in the server package rather than in `runtime` on purpose. A mount is
 * an operational event of whatever process is hosting the corpus, and pushing the
 * tracer into `corpus-snapshot.ts` would make an immutable-loading primitive
 * depend on a telemetry decision. It also keeps this lane out of that file, which
 * another lane owns.
 */

import { NOOP_TRACER, withSpan, type SpanContext, type Tracer } from "@skill-wiki/observability";
import {
  CorpusRegistry,
  type CorpusMountRequest,
  type FailedMount,
  type MountedCorpus,
} from "@skill-wiki/runtime";

export const SPAN_CORPUS_MOUNT = "aoe.corpus.mount";
export const SPAN_CORPUS_ACTIVATE = "aoe.corpus.activate";

/** Events on the mount span, one per outcome, so a count query can separate them. */
export const EVENT_CORPUS_MOUNTED = "aoe.corpus.mounted";
export const EVENT_CORPUS_MOUNT_FAILED = "aoe.corpus.mount_failed";
export const EVENT_CORPUS_SWITCHED = "aoe.corpus.switched";

export interface TraceScope {
  readonly tracer: Tracer;
  readonly parent?: SpanContext;
}

function spanOptions(scope: TraceScope): { readonly parent?: SpanContext } {
  return scope.parent === undefined ? {} : { parent: scope.parent };
}

export interface MountOutcome {
  readonly registry: CorpusRegistry;
  readonly failed: readonly FailedMount[];
}

/**
 * Mounts every request and records one event per mount, successful or not.
 *
 * A failed mount is an event on a span that still ends `ok`, because the *mount
 * operation* completed and reported its failures — `CorpusRegistry.from` is
 * partial by design. The span's `aoe.failed_mounts` attribute is what an alert
 * fires on; a span status of `error` here would instead mean "the mounting code
 * itself broke", and conflating the two makes both unmonitorable.
 */
export function mountCorpora(
  requests: readonly CorpusMountRequest[],
  scope: TraceScope,
  options: { readonly namespaceSource?: CorpusRegistryNamespaceSource } = {},
): MountOutcome {
  return withSpan(scope.tracer ?? NOOP_TRACER, SPAN_CORPUS_MOUNT, spanOptions(scope), span => {
    const outcome = CorpusRegistry.from(requests, options);
    for (const mount of outcome.registry.all()) {
      span.addEvent(EVENT_CORPUS_MOUNTED, {
        "aoe.corpus_namespace": mount.namespace,
        "aoe.corpus_release": mount.release,
        "aoe.corpus_digest": mount.loaded.snapshot.contentDigest,
        "aoe.mount_diagnostics": mount.diagnostics.length,
      });
    }
    for (const failure of outcome.failed) {
      // The path is reported and the diagnostics are counted, not inlined: a
      // mount diagnostic can quote manifest contents, and a trace is a wider
      // audience than the operator's console.
      span.addEvent(EVENT_CORPUS_MOUNT_FAILED, {
        "aoe.mount_path": failure.path,
        "aoe.mount_diagnostics": failure.diagnostics.length,
        "aoe.mount_codes": failure.diagnostics.map(diagnostic => diagnostic.code),
      });
    }
    span.setAttributes({
      "aoe.requested_mounts": requests.length,
      "aoe.mounted": outcome.registry.size,
      "aoe.failed_mounts": outcome.failed.length,
    });
    return outcome;
  });
}

/** `NamespaceSource` as `runtime` declares it, re-typed structurally to avoid re-exporting it. */
export type CorpusRegistryNamespaceSource = Parameters<typeof CorpusRegistry.from>[1] extends
  { namespaceSource?: infer T } | undefined ? T : never;

export type SwitchOutcome =
  | { readonly ok: true; readonly namespace: string; readonly release: string; readonly previous?: string }
  | { readonly ok: false; readonly reason: string; readonly code: string };

/**
 * Points a namespace at an already-mounted release.
 *
 * This is the "corpus switch" event Phase 5 asks to be observable. It is the one
 * transition on a read-only server that changes what a later query returns, so a
 * trace without it cannot explain why two identical requests produced different
 * plans.
 */
export function switchRelease(
  registry: CorpusRegistry,
  namespace: string,
  release: string,
  scope: TraceScope,
): SwitchOutcome {
  return withSpan(scope.tracer ?? NOOP_TRACER, SPAN_CORPUS_ACTIVATE, spanOptions(scope), span => {
    span.setAttributes({ "aoe.corpus_namespace": namespace, "aoe.corpus_release": release });
    const previous = registry.activeRelease(namespace);
    const result = registry.activate(namespace, release);
    if (!result.ok) {
      span.setStatus({ code: "error", message: result.diagnostic.code });
      span.setAttribute("aoe.activate_code", result.diagnostic.code);
      return { ok: false, reason: result.diagnostic.message, code: result.diagnostic.code };
    }
    span.addEvent(EVENT_CORPUS_SWITCHED, {
      "aoe.corpus_namespace": namespace,
      "aoe.corpus_release": release,
      "aoe.previous_release": previous ?? "",
    });
    span.setStatus({ code: "ok" });
    return previous === undefined
      ? { ok: true, namespace, release }
      : { ok: true, namespace, release, previous };
  });
}

export function describeMount(mount: MountedCorpus): Readonly<Record<string, unknown>> {
  return {
    namespace: mount.namespace,
    release: mount.release,
    manifestCorpus: mount.manifestCorpus,
    corpusDigest: mount.loaded.snapshot.contentDigest,
    diagnostics: mount.diagnostics.length,
  };
}
