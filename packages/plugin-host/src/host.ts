/**
 * The host: discovery plus the §12.2 lifecycle driver.
 *
 * The host owns no policy of its own. Everything it is allowed to admit, grant
 * or run comes from `HostPolicy`, and every field of that policy is
 * deny-by-default: empty `acceptedProvides` accepts no plugin, absent
 * capability grants grant nothing, and a sandbox mode with no executor is
 * refused instead of downgraded. That is the §3.5 default made structural — a
 * host constructed with `{}` is a host that runs nothing, which is the correct
 * failure direction.
 *
 * `acceptedProvides` is where §3.5's five categories belong (connector,
 * reranker, validator, side-effect Action Provider, renderer). They are the
 * operator's list, not a constant in this file: an engine that shipped the list
 * would have to be edited to admit the sixth legitimate category, and would be
 * asserting a taxonomy §3.1 says the engine must not own.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { authorizeCapabilities, NO_CAPABILITIES, type CapabilityGrantSet } from "./capabilities.ts";
import { hostEvent, type HostEventSink, type Scope } from "./events.ts";
import { createExecutor, DEFAULT_EXECUTORS, type CallResult, type ExecutorFactory, type SandboxExecutor } from "./executor/process.ts";
import { PluginLifecycle, type LifecycleState } from "./lifecycle.ts";
import { loadManifest, type ManifestDiagnostic, type PluginManifest } from "./manifest.ts";
import { checkProvenance, computePluginDigest, DEFAULT_SIGNATURE_POLICY, PluginDigestRegistry, verifyPluginSignature, type ProvenancePolicy, type SignaturePolicy } from "./trust.ts";

export interface HostPolicy extends ProvenancePolicy {
  /**
   * `<role>:<id>` values the operator accepts. Empty accepts nothing.
   * A bare role (`action-executor`) accepts every id under it, which is the one
   * widening allowed anywhere in this package and only because a role is a
   * *kind* of extension while a capability is an authority.
   */
  readonly acceptedProvides: readonly string[];
  /** plugin name → capabilities the operator grants it. Absent means none. */
  readonly capabilityGrants: Readonly<Record<string, readonly string[]>>;
  readonly signature?: SignaturePolicy;
  readonly scope: Scope;
  readonly sink?: HostEventSink;
  readonly executors?: Readonly<Record<string, ExecutorFactory>>;
  readonly runtime?: string;
  readonly fetcher?: (url: string) => Promise<string>;
}

export interface RejectedPlugin {
  readonly dir: string;
  readonly code: string;
  readonly reason: string;
}

export interface PluginRecord {
  readonly name: string;
  readonly root: string;
  readonly entryPath: string;
  readonly manifest: PluginManifest;
  readonly digest: string;
  readonly lifecycle: PluginLifecycle;
  grants: CapabilityGrantSet;
  executor?: SandboxExecutor;
}

function providesAccepted(provides: readonly string[], accepted: readonly string[]): boolean {
  return provides.every(entry => {
    const role = entry.split(":", 1)[0]!;
    return accepted.includes(entry) || accepted.includes(role);
  });
}

export class PluginHost {
  private readonly registry = new PluginDigestRegistry();
  private readonly records = new Map<string, PluginRecord>();
  private readonly rejections: RejectedPlugin[] = [];
  private readonly sink: HostEventSink;

  constructor(private readonly policy: HostPolicy) {
    this.sink = policy.sink ?? ((): void => {});
  }

  get rejected(): readonly RejectedPlugin[] {
    return this.rejections;
  }

  get plugins(): readonly PluginRecord[] {
    return [...this.records.values()];
  }

  stateOf(name: string): LifecycleState | undefined {
    return this.records.get(name)?.lifecycle.state;
  }

  /**
   * §12.2 step 1. Every candidate directory under every declared plugin root.
   * A candidate that fails provenance, schema or digest uniqueness is recorded as
   * a rejection with its code — never skipped silently, because a plugin that
   * simply does not appear is indistinguishable from one that was never installed.
   */
  discover(): readonly PluginRecord[] {
    for (const root of this.policy.pluginRoots) {
      if (!existsSync(root)) {
        this.reject(root, "PLUGIN_ROOT_MISSING", `Declared plugin root does not exist: ${root}`);
        continue;
      }
      for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!entry.isDirectory()) continue;
        this.admit(join(root, entry.name));
      }
    }
    return this.plugins;
  }

  private admit(dir: string): void {
    const provenance = checkProvenance(dir, this.policy);
    if (!provenance.ok) {
      this.reject(dir, provenance.code, provenance.reason);
      return;
    }
    const loaded = loadManifest(dir);
    if (!loaded.ok) {
      this.reject(dir, firstCode(loaded.diagnostics), firstMessage(loaded.diagnostics));
      return;
    }
    const digest = computePluginDigest(loaded.root);
    const unique = this.registry.record(loaded.manifest.name, loaded.manifest.version, digest);
    if (!unique.ok) {
      this.reject(dir, unique.code, unique.reason);
      return;
    }
    if (this.records.has(loaded.manifest.name)) {
      this.reject(dir, "PLUGIN_NAME_DUPLICATE", `A plugin named ${loaded.manifest.name} is already loaded`);
      return;
    }
    const record: PluginRecord = {
      name: loaded.manifest.name,
      root: loaded.root,
      entryPath: loaded.entryPath,
      manifest: loaded.manifest,
      digest,
      lifecycle: new PluginLifecycle(),
      grants: NO_CAPABILITIES,
    };
    this.records.set(record.name, record);
    this.sink(hostEvent({ kind: "plugin.discovered", plugin: record.name, scope: this.policy.scope, payload: { dir, digest, provides: loaded.manifest.provides } }));
  }

  private reject(dir: string, code: string, reason: string): void {
    this.rejections.push({ dir, code, reason });
    this.sink(hostEvent({ kind: "plugin.rejected", plugin: dir, scope: this.policy.scope, payload: { code, reason } }));
  }

  /**
   * §12.2 steps 2–7, in order, stopping at the first refusal. The ordering is the
   * point: nothing in this method loads plugin code before `authorized`, so a
   * plugin that fails any earlier gate has never executed a byte.
   */
  async activate(name: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly at: LifecycleState; readonly code: string; readonly reason: string }> {
    const record = this.records.get(name);
    if (record === undefined) return { ok: false, at: "discovered", code: "PLUGIN_UNKNOWN", reason: `No discovered plugin named ${name}` };

    // verify signature
    const signature = verifyPluginSignature(record.root, record.manifest, this.policy.signature ?? DEFAULT_SIGNATURE_POLICY);
    if (!signature.ok) return this.abort(record, signature.code, signature.reason);
    record.lifecycle.advance("verified");

    // resolve dependencies
    const missing = Object.keys(record.manifest.dependencies).filter(dep => !this.records.has(dep));
    if (missing.length > 0) return this.abort(record, "DEPENDENCY_UNRESOLVED", `Unresolved plugin dependencies: ${missing.sort().join(", ")}`);
    record.lifecycle.advance("dependencies-resolved");

    // authorize capabilities
    if (!providesAccepted(record.manifest.provides, this.policy.acceptedProvides)) {
      return this.abort(record, "PROVIDES_NOT_ACCEPTED", `Host accepts none of ${record.manifest.provides.join(", ")}`);
    }
    const authorization = authorizeCapabilities(record.manifest.capabilities, this.policy.capabilityGrants[name] ?? []);
    if (authorization.malformed.length > 0) {
      return this.abort(record, "CAPABILITY_MALFORMED", `Malformed capabilities: ${authorization.malformed.join(", ")}`);
    }
    record.grants = authorization.grants;
    record.lifecycle.advance("authorized");
    this.sink(hostEvent({
      kind: "plugin.authorized",
      plugin: name,
      scope: this.policy.scope,
      payload: {
        granted: [...authorization.grants.granted].sort(),
        declaredButNotGranted: authorization.declarationsWithoutGrant,
        grantedButNotDeclared: authorization.grantsWithoutDeclaration,
      },
    }));

    // initialize — the first moment plugin code exists anywhere
    const created = createExecutor({
      root: record.root,
      entryPath: record.entryPath,
      manifest: record.manifest,
      grants: record.grants,
      scope: this.policy.scope,
      sink: this.sink,
      runtime: this.policy.runtime,
      fetcher: this.policy.fetcher,
    }, this.policy.executors ?? DEFAULT_EXECUTORS);
    if (!created.ok) return this.abort(record, created.code, created.reason);
    record.executor = created.executor;
    try {
      await created.executor.start();
    } catch (error) {
      return this.abort(record, "INITIALIZE_FAILED", error instanceof Error ? error.message : "sandbox start failed");
    }
    record.lifecycle.advance("initialized");

    // health check — the sandbox answered `ready`, which is the liveness signal
    record.lifecycle.advance("healthy");
    record.lifecycle.advance("serving");
    this.sink(hostEvent({ kind: "plugin.state", plugin: name, scope: this.policy.scope, payload: { state: record.lifecycle.state } }));
    return { ok: true };
  }

  private abort(record: PluginRecord, code: string, reason: string): { readonly ok: false; readonly at: LifecycleState; readonly code: string; readonly reason: string } {
    const at = record.lifecycle.state;
    record.lifecycle.fail(`${code}: ${reason}`);
    this.sink(hostEvent({ kind: "plugin.failed", plugin: record.name, scope: this.policy.scope, payload: { at, code, reason } }));
    return { ok: false, at, code, reason };
  }

  /** Dispatch is refused unless the plugin is `serving`. */
  async call(name: string, method: string, params: unknown): Promise<CallResult> {
    const record = this.records.get(name);
    if (record === undefined) return { ok: false, code: "PLUGIN_UNKNOWN", reason: `No plugin named ${name}` };
    if (!record.lifecycle.isServing) {
      return { ok: false, code: "PLUGIN_NOT_SERVING", reason: `${name} is ${record.lifecycle.state}, not serving` };
    }
    if (record.executor === undefined) return { ok: false, code: "PLUGIN_NOT_SERVING", reason: `${name} has no executor` };
    this.sink(hostEvent({ kind: "plugin.call", plugin: name, scope: this.policy.scope, payload: { method } }));
    return record.executor.call(method, params);
  }

  /** §12.2 drain → shutdown. Idempotent, and safe from any state. */
  async shutdown(name: string): Promise<void> {
    const record = this.records.get(name);
    if (record === undefined) return;
    if (record.lifecycle.isServing) {
      record.lifecycle.advance("draining");
      await record.executor?.drain();
    }
    await record.executor?.shutdown();
    record.lifecycle.shutdown();
    this.sink(hostEvent({ kind: "plugin.state", plugin: name, scope: this.policy.scope, payload: { state: record.lifecycle.state } }));
  }

  async shutdownAll(): Promise<void> {
    for (const name of [...this.records.keys()]) await this.shutdown(name);
  }
}

function firstCode(diagnostics: readonly ManifestDiagnostic[]): string {
  return diagnostics[0]?.code ?? "MANIFEST_INVALID";
}

function firstMessage(diagnostics: readonly ManifestDiagnostic[]): string {
  return diagnostics.map(d => d.message).join("; ");
}
