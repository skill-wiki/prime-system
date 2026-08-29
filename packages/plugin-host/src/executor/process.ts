/**
 * The process-isolated executor (plan §3.5 "运行于隔离进程", §12.1 `sandbox.mode: process`).
 *
 * What this genuinely provides, and what it does not — stated plainly because a
 * sandbox that is trusted for more than it delivers is worse than none:
 *
 * PROVIDES
 * - A separate OS process, so a plugin cannot read or patch host memory, and a
 *   crash or an infinite loop is contained (`timeoutMs` then SIGKILL).
 * - No ambient host handles: the child gets stdio and argv, an environment the
 *   executor built explicitly (the host's own env — which is where secrets live —
 *   is NOT inherited), and a cwd of its own bundle.
 * - Every effect mediated: each `readFile`/`fetch` crosses `checkCapability`
 *   (deny-by-default, two gates) and, for paths, `resolveInRoot` against the read
 *   roots the manifest declared. A refusal is an event, not a silent empty result.
 *
 * DOES NOT PROVIDE
 * - OS-level confinement of the child's *own* syscalls. A plugin that imports
 *   `node:fs` inside the child can read whatever the OS user can read. Closing
 *   that requires the container or WASI mode §3.5 also names, which is a
 *   different executor behind the same `SandboxExecutor` interface — the mode is
 *   a manifest field precisely so that swap needs no plugin change. Recorded as a
 *   known gap rather than papered over: refusing an unknown mode (below) is what
 *   keeps a `wasi` plugin from silently running under this weaker one.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkCapability, type CapabilityGrantSet } from "../capabilities.ts";
import { hostEvent, type HostEventSink, type Scope } from "../events.ts";
import type { PluginManifest } from "../manifest.ts";
import { resolveInRoot } from "../paths.ts";
import { FrameDecoder, encodeFrame, type ChildFrame, type HostFrame, type FileReadRequest, type NetworkRequest } from "./protocol.ts";

const CHILD_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "child.ts");

export type ExecutionRefusalCode =
  | "SANDBOX_MODE_UNSUPPORTED"
  | "SANDBOX_NOT_RUNNING"
  | "CALL_TIMEOUT"
  | "CALL_FAILED";

export type CallResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface SandboxExecutor {
  readonly mode: string;
  start(): Promise<void>;
  call(method: string, params: unknown): Promise<CallResult>;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ProcessExecutorOptions {
  readonly root: string;
  readonly entryPath: string;
  readonly manifest: PluginManifest;
  readonly grants: CapabilityGrantSet;
  readonly scope: Scope;
  readonly sink: HostEventSink;
  /**
   * Runtime that can execute the TypeScript child. Defaults to whatever is
   * running the host, which is correct under `bun`; a Node host must pass a
   * loader-capable command rather than have one guessed for it.
   */
  readonly runtime?: string;
  /** Network fetcher. Absent means every network effect is refused. */
  readonly fetcher?: (url: string) => Promise<string>;
}

interface Pending {
  resolve(result: CallResult): void;
  timer: ReturnType<typeof setTimeout>;
}

export const PROCESS_SANDBOX_MODE = "process";

export class ProcessSandboxExecutor implements SandboxExecutor {
  readonly mode = PROCESS_SANDBOX_MODE;
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new FrameDecoder<ChildFrame>();
  private nextId = 1;
  private ready: Promise<void> | undefined;
  private stderr = "";

  constructor(private readonly options: ProcessExecutorOptions) {}

  async start(): Promise<void> {
    if (this.child !== undefined) return;
    const runtime = this.options.runtime ?? process.execPath;
    const granted = [...this.options.grants.granted].sort();
    this.child = spawn(runtime, [CHILD_ENTRY, this.options.entryPath, JSON.stringify(granted)], {
      cwd: this.options.root,
      // The host's environment is deliberately not inherited: it is where API
      // keys live, and inheriting it would put every secret the host holds inside
      // an untrusted process for free. PATH is passed because the runtime needs
      // to resolve its own helpers.
      env: { PATH: process.env["PATH"] ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });

    this.ready = new Promise<void>((resolve, reject) => {
      const onData = (chunk: string): void => {
        for (const frame of this.decoder.push(chunk)) {
          if (frame.t === "ready") resolve();
          else void this.onFrame(frame);
        }
      };
      this.child!.stdout.on("data", onData);
      this.child!.on("exit", code => {
        this.failAllPending(`Sandbox exited with code ${code}${this.stderr === "" ? "" : `: ${this.stderr.trim()}`}`);
        reject(new Error(`Sandbox exited before ready (code ${code})`));
      });
      this.child!.on("error", error => reject(error));
    });
    // A `ready` that never arrives must not hang the host: the same ceiling that
    // bounds a call bounds startup.
    await withTimeout(this.ready, this.options.manifest.sandbox.timeoutMs, "Sandbox did not become ready");
  }

  async call(method: string, params: unknown): Promise<CallResult> {
    if (this.child === undefined) return { ok: false, code: "SANDBOX_NOT_RUNNING", reason: "Sandbox was never started" };
    const id = this.nextId++;
    return new Promise<CallResult>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A plugin that will not return is killed, not waited on. Leaving it
        // alive is how one hung call becomes an exhausted process table.
        this.child?.kill("SIGKILL");
        resolve({ ok: false, code: "CALL_TIMEOUT", reason: `${method} exceeded ${this.options.manifest.sandbox.timeoutMs}ms` });
      }, this.options.manifest.sandbox.timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ t: "call", id, method, params });
    });
  }

  async drain(): Promise<void> {
    if (this.child === undefined) return;
    this.send({ t: "drain" });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.failAllPending("Sandbox was shut down");
    if (child === undefined) return;
    child.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 200);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private send(frame: HostFrame): void {
    this.child?.stdin.write(encodeFrame(frame));
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: "CALL_FAILED", reason });
    }
    this.pending.clear();
  }

  private async onFrame(frame: ChildFrame): Promise<void> {
    if (frame.t === "result" || frame.t === "error") {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve(frame.t === "result"
        ? { ok: true, value: frame.value }
        : { ok: false, code: frame.code, reason: frame.message });
      return;
    }
    if (frame.t === "effect") {
      await this.mediate(frame.id, frame.capability, frame.request);
      return;
    }
  }

  /**
   * The mediation point. Capability first, then the effect-specific containment:
   * a granted capability is permission to ask, never permission to reach an
   * arbitrary target.
   */
  private async mediate(id: number, capability: string, request: unknown): Promise<void> {
    const decision = checkCapability(this.options.grants, capability);
    if (!decision.granted) {
      this.refuse(id, decision.code, decision.reason, capability);
      return;
    }
    const namespace = capability.split(":", 1)[0]!;
    if (namespace === "filesystem") {
      this.mediateRead(id, capability, request as FileReadRequest);
      return;
    }
    if (namespace === "network") {
      await this.mediateNetwork(id, capability, request as NetworkRequest);
      return;
    }
    // An unknown namespace is refused, not forwarded. A host that forwards what
    // it does not understand is a confused deputy.
    this.refuse(id, "EFFECT_UNSUPPORTED", `Host cannot mediate capability namespace ${namespace}`, capability);
  }

  private mediateRead(id: number, capability: string, request: FileReadRequest): void {
    const filesystem = this.options.manifest.sandbox.filesystem;
    if (filesystem === "none") {
      this.refuse(id, "FILESYSTEM_NONE", "Manifest declares filesystem: none", capability);
      return;
    }
    const path = typeof request?.path === "string" ? request.path : "";
    // Containment is proven against each declared read root, so a plugin allowed
    // to read `templates/` cannot read a sibling directory it never declared.
    for (const root of filesystem.readRoots) {
      const rootResolved = resolveInRoot(this.options.root, root, "any");
      if (!rootResolved.ok) continue;
      const target = resolveInRoot(rootResolved.absolutePath, path, "file");
      if (target.ok) {
        this.options.sink(hostEvent({ kind: "plugin.effect.granted", plugin: this.options.manifest.name, scope: this.options.scope, payload: { capability, path } }));
        this.send({ t: "effect-result", id, ok: true, value: readFileSync(target.absolutePath, "utf8") });
        return;
      }
      // Keep the last structural refusal so the plugin learns *why*, not just no.
      if (target.code !== "PATH_NOT_FOUND") {
        this.refuse(id, target.code, target.reason, capability, path);
        return;
      }
    }
    this.refuse(id, "PATH_NOT_IN_READ_ROOTS", `No declared read root contains ${JSON.stringify(path)}`, capability, path);
  }

  private async mediateNetwork(id: number, capability: string, request: NetworkRequest): Promise<void> {
    const url = typeof request?.url === "string" ? request.url : "";
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      this.refuse(id, "NETWORK_URL_INVALID", `Not a URL: ${JSON.stringify(url)}`, capability);
      return;
    }
    // Exact host match. No suffix matching: `evil-api.example.com` ends with
    // nothing that `api.example.com` allows, but a naive `endsWith` on
    // `.example.com` would let `evil.example.com` through.
    if (!this.options.manifest.sandbox.networkAllowlist.includes(host)) {
      this.refuse(id, "NETWORK_HOST_NOT_ALLOWLISTED", `${host} is not in the manifest networkAllowlist`, capability, url);
      return;
    }
    const fetcher = this.options.fetcher;
    if (fetcher === undefined) {
      this.refuse(id, "NETWORK_NO_FETCHER", "Host provided no network fetcher", capability, url);
      return;
    }
    try {
      const value = await fetcher(url);
      this.options.sink(hostEvent({ kind: "plugin.effect.granted", plugin: this.options.manifest.name, scope: this.options.scope, payload: { capability, host } }));
      this.send({ t: "effect-result", id, ok: true, value });
    } catch (error) {
      this.refuse(id, "NETWORK_FAILED", error instanceof Error ? error.message : "fetch failed", capability, url);
    }
  }

  private refuse(id: number, code: string, reason: string, capability: string, target?: string): void {
    this.options.sink(hostEvent({
      kind: "plugin.effect.refused",
      plugin: this.options.manifest.name,
      scope: this.options.scope,
      payload: { capability, code, reason, ...(target === undefined ? {} : { target }) },
    }));
    this.send({ t: "effect-result", id, ok: false, code, reason });
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Mode → executor. A mode with no entry here is refused by `createExecutor`,
 * which is the invariant that matters: there is no fallback to in-process
 * execution, so a manifest asking for `wasi` on a host that has no WASI executor
 * fails closed instead of quietly running unconfined.
 */
export type ExecutorFactory = (options: ProcessExecutorOptions) => SandboxExecutor;

export const DEFAULT_EXECUTORS: Readonly<Record<string, ExecutorFactory>> = {
  [PROCESS_SANDBOX_MODE]: options => new ProcessSandboxExecutor(options),
};

export function createExecutor(
  options: ProcessExecutorOptions,
  executors: Readonly<Record<string, ExecutorFactory>> = DEFAULT_EXECUTORS,
): { readonly ok: true; readonly executor: SandboxExecutor } | { readonly ok: false; readonly code: ExecutionRefusalCode; readonly reason: string } {
  const factory = executors[options.manifest.sandbox.mode];
  if (factory === undefined) {
    return {
      ok: false,
      code: "SANDBOX_MODE_UNSUPPORTED",
      reason: `No executor for sandbox mode ${JSON.stringify(options.manifest.sandbox.mode)}; refusing rather than running in-process`,
    };
  }
  return { ok: true, executor: factory(options) };
}
