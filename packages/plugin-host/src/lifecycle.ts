/**
 * Plugin lifecycle state machine (plan §12.2).
 *
 * ```text
 * discover → verify signature → resolve dependencies → authorize capabilities
 *          → initialize → health check → serve → drain → shutdown
 * ```
 *
 * The reason this is a machine and not a sequence of `await`s in one function:
 * §12.2's ordering *is* a security property, not a convenience. `authorize
 * capabilities` sits before `initialize`, which means no plugin code runs until
 * the grant set is fixed. Written as straight-line code that ordering holds only
 * as long as nobody reorders two lines; written as a machine, a call that tries
 * to serve a plugin that was never authorized is refused by construction and the
 * refusal names the skipped step.
 *
 * Transitions are forward-only along the declared chain, plus `fail` from any
 * live state and `shutdown` from any state at all. Deliberately no `retry`
 * edge back to an earlier state: a plugin that failed verification must be
 * discovered again from disk, because its bytes are what failed and re-running
 * the check on the in-memory record it produced proves nothing.
 */

export type LifecycleState =
  | "discovered"
  | "verified"
  | "dependencies-resolved"
  | "authorized"
  | "initialized"
  | "healthy"
  | "serving"
  | "draining"
  | "stopped"
  | "failed";

/** The one legal successor of each state, mirroring §12.2 exactly. */
const NEXT: Readonly<Record<LifecycleState, LifecycleState | undefined>> = {
  discovered: "verified",
  verified: "dependencies-resolved",
  "dependencies-resolved": "authorized",
  authorized: "initialized",
  initialized: "healthy",
  healthy: "serving",
  serving: "draining",
  draining: "stopped",
  stopped: undefined,
  failed: undefined,
};

/** States from which no further work may be dispatched. */
export const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set<LifecycleState>(["stopped", "failed"]);

/** The only state in which a plugin may be handed a request. */
export const SERVING_STATE: LifecycleState = "serving";

export type TransitionRefusalCode = "LIFECYCLE_TERMINAL" | "LIFECYCLE_OUT_OF_ORDER";

export type TransitionResult =
  | { readonly ok: true; readonly from: LifecycleState; readonly to: LifecycleState }
  | { readonly ok: false; readonly code: TransitionRefusalCode; readonly reason: string; readonly from: LifecycleState; readonly attempted: LifecycleState };

export interface LifecycleEntry {
  readonly state: LifecycleState;
  /** Why, for a `failed` transition. */
  readonly detail?: string;
}

/**
 * One plugin's lifecycle. Holds the history, not just the current state, because
 * §3.6 requires every decision to be explainable and "why is this plugin not
 * serving?" is answered by the step it stopped at, not by the word `failed`.
 */
export class PluginLifecycle {
  private current: LifecycleState = "discovered";
  private readonly log: LifecycleEntry[] = [{ state: "discovered" }];

  get state(): LifecycleState {
    return this.current;
  }

  get history(): readonly LifecycleEntry[] {
    return this.log;
  }

  get isServing(): boolean {
    return this.current === SERVING_STATE;
  }

  /** Advance exactly one step along §12.2. Any skip is refused, naming the gap. */
  advance(to: LifecycleState): TransitionResult {
    const from = this.current;
    if (TERMINAL_STATES.has(from)) {
      return { ok: false, code: "LIFECYCLE_TERMINAL", reason: `Plugin is ${from}; it must be rediscovered`, from, attempted: to };
    }
    const expected = NEXT[from];
    if (expected !== to) {
      return {
        ok: false,
        code: "LIFECYCLE_OUT_OF_ORDER",
        reason: expected === undefined
          ? `No transition leaves ${from}`
          : `${from} may only advance to ${expected}, not ${to}: ${expected} would be skipped`,
        from,
        attempted: to,
      };
    }
    this.current = to;
    this.log.push({ state: to });
    return { ok: true, from, to };
  }

  /** Walk the whole chain to `target`, stopping at the first refusal. */
  advanceTo(target: LifecycleState): TransitionResult {
    let last: TransitionResult = { ok: true, from: this.current, to: this.current };
    while (this.current !== target) {
      const next = NEXT[this.current];
      if (next === undefined) {
        return { ok: false, code: "LIFECYCLE_OUT_OF_ORDER", reason: `${target} is not reachable from ${this.current}`, from: this.current, attempted: target };
      }
      last = this.advance(next);
      if (!last.ok) return last;
    }
    return last;
  }

  /** Available from any live state; carries the reason into the history. */
  fail(detail: string): TransitionResult {
    const from = this.current;
    if (TERMINAL_STATES.has(from)) {
      return { ok: false, code: "LIFECYCLE_TERMINAL", reason: `Plugin is already ${from}`, from, attempted: "failed" };
    }
    this.current = "failed";
    this.log.push({ state: "failed", detail });
    return { ok: true, from, to: "failed" };
  }

  /**
   * Available from any state including `failed`, and idempotent. Shutdown is the
   * one edge that must never be refusable: a host that cannot stop a plugin
   * because the plugin is in the wrong state has no way to release its process.
   */
  shutdown(detail?: string): TransitionResult {
    const from = this.current;
    if (from === "stopped") return { ok: true, from, to: "stopped" };
    this.current = "stopped";
    this.log.push({ state: "stopped", detail });
    return { ok: true, from, to: "stopped" };
  }
}
