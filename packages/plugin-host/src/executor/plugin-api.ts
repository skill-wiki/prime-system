/**
 * The plugin-facing API surface.
 *
 * Separate from `child.ts` on purpose, and the reason is a bug this split fixes
 * rather than a preference: `child.ts` runs `main()` at module scope — it is a
 * program, not a library. Re-exporting these types from there would mean that
 * importing `@skill-wiki/plugin-host` in the *host* process starts a sandbox
 * bootstrap that attaches to the host's stdin. Types a plugin author needs must
 * therefore live in a module with no side effects at all.
 */

export interface PluginContext {
  /** Exactly what the host granted. Informational: the host re-checks every call. */
  readonly capabilities: readonly string[];
  /** Read a file inside the plugin's own declared read roots, via the host. */
  readFile(path: string): Promise<string>;
  /** Fetch a URL the host's allowlist permits, via the host. */
  fetch(url: string): Promise<string>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface PluginModule {
  /** Method names this plugin answers. Advertised to the host on `ready`. */
  readonly methods?: readonly string[];
  handle(method: string, params: unknown, context: PluginContext): unknown | Promise<unknown>;
}

/** Capability namespaces the mediated context uses. Protocol-level, not domain. */
export const FILESYSTEM_READ_CAPABILITY = "filesystem:read";
