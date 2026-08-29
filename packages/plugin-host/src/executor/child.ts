/**
 * The sandbox child: the ONLY place plugin code is ever loaded.
 *
 * Invoked as a separate OS process by `process.ts`, never imported by the host.
 * It receives its entire configuration on argv — entry path, granted capability
 * list, bundle root — and nothing else: no host objects, no open descriptors
 * beyond stdio, no environment inherited from the host beyond what the executor
 * chose to pass.
 *
 * The context handed to the plugin performs no I/O of its own. `readFile` and
 * `fetch` marshal a request to the host and wait; the host is where the
 * capability check and the path containment happen. A plugin that wants to skip
 * that mediation has to attack the OS, not the API — which is the difference
 * between an isolation model and a naming convention.
 */

import { FrameDecoder, encodeFrame, type ChildFrame, type HostFrame } from "./protocol.ts";
import { FILESYSTEM_READ_CAPABILITY, type PluginContext, type PluginModule } from "./plugin-api.ts";

function write(frame: ChildFrame): void {
  process.stdout.write(encodeFrame(frame));
}

/**
 * Pending host effects, keyed by the id the child assigned. Ids for effects come
 * from a separate counter than call ids so a plugin cannot forge a reply to a
 * call by choosing an effect id.
 */
const pendingEffects = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextEffectId = 1;

function requestEffect(capability: string, request: unknown): Promise<unknown> {
  const id = nextEffectId++;
  return new Promise<unknown>((resolve, reject) => {
    pendingEffects.set(id, { resolve, reject });
    write({ t: "effect", id, capability, request });
  });
}

function makeContext(granted: readonly string[]): PluginContext {
  return {
    capabilities: granted,
    readFile: async (path: string): Promise<string> => {
      const value = await requestEffect(FILESYSTEM_READ_CAPABILITY, { path });
      return typeof value === "string" ? value : String(value);
    },
    fetch: async (url: string): Promise<string> => {
      // The scheme is part of the capability because §12.1's example is
      // `network:https`: permitting http and https separately is the operator's
      // decision, and deriving it here keeps that decision in the grant set.
      const scheme = url.split(":", 1)[0]!.toLowerCase();
      const value = await requestEffect(`network:${scheme}`, { url });
      return typeof value === "string" ? value : String(value);
    },
    log: (level, message) => write({ t: "log", level, message }),
  };
}

async function main(): Promise<void> {
  const [entryPath, grantedJson] = process.argv.slice(2);
  if (entryPath === undefined) {
    write({ t: "error", id: 0, code: "CHILD_NO_ENTRY", message: "No plugin entry path was passed" });
    process.exit(2);
  }
  let granted: readonly string[] = [];
  try {
    granted = grantedJson === undefined ? [] : (JSON.parse(grantedJson) as readonly string[]);
  } catch {
    granted = [];
  }

  let plugin: PluginModule;
  try {
    const loaded = (await import(entryPath)) as { default?: unknown } & Record<string, unknown>;
    const candidate = (loaded.default ?? loaded) as Partial<PluginModule>;
    if (typeof candidate.handle !== "function") {
      write({ t: "error", id: 0, code: "PLUGIN_NO_HANDLE", message: "Plugin does not export handle()" });
      process.exit(3);
    }
    plugin = candidate as PluginModule;
  } catch (error) {
    write({ t: "error", id: 0, code: "PLUGIN_LOAD_FAILED", message: error instanceof Error ? error.message : "import failed" });
    process.exit(3);
    return;
  }

  const context = makeContext(granted);
  const decoder = new FrameDecoder<HostFrame>();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    for (const frame of decoder.push(chunk)) void dispatch(frame);
  });

  async function dispatch(frame: HostFrame): Promise<void> {
    if (frame.t === "effect-result") {
      const pending = pendingEffects.get(frame.id);
      if (pending === undefined) return;
      pendingEffects.delete(frame.id);
      if (frame.ok) pending.resolve(frame.value);
      else pending.reject(new Error(`${frame.code}: ${frame.reason}`));
      return;
    }
    if (frame.t === "drain") {
      write({ t: "drained" });
      return;
    }
    try {
      const value = await plugin.handle(frame.method, frame.params, context);
      write({ t: "result", id: frame.id, value });
    } catch (error) {
      write({ t: "error", id: frame.id, code: "PLUGIN_THREW", message: error instanceof Error ? error.message : "plugin threw" });
    }
  }

  write({ t: "ready", methods: plugin.methods ?? [] });
}

void main();
