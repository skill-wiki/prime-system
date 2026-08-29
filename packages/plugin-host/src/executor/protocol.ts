/**
 * The host↔sandbox wire protocol.
 *
 * Newline-delimited JSON over the child's stdio. The shape encodes the isolation
 * model rather than merely serialising calls: a plugin has **no ambient
 * handles**. It cannot read a file or open a socket itself — it asks the host,
 * over this channel, and the host answers or refuses. That inversion is what
 * makes `capabilities.ts` and `paths.ts` load-bearing instead of advisory: a
 * check the plugin could bypass by calling `node:fs` directly would be
 * decoration, and a plugin that imports `node:fs` in this design gets a path
 * outside its own bundle only if the OS lets it — which is why the process
 * boundary is the floor and not the ceiling (see the gap noted in `process.ts`).
 *
 * Every frame carries an `id` so a slow effect cannot be mistaken for the reply
 * to a later call.
 */

/** Parent → child. */
export type HostFrame =
  | { readonly t: "call"; readonly id: number; readonly method: string; readonly params: unknown }
  | { readonly t: "effect-result"; readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly t: "effect-result"; readonly id: number; readonly ok: false; readonly code: string; readonly reason: string }
  | { readonly t: "drain" };

/** Child → parent. */
export type ChildFrame =
  | { readonly t: "ready"; readonly methods: readonly string[] }
  | { readonly t: "result"; readonly id: number; readonly value: unknown }
  | { readonly t: "error"; readonly id: number; readonly code: string; readonly message: string }
  /** A capability-bearing request the child cannot perform itself. */
  | { readonly t: "effect"; readonly id: number; readonly capability: string; readonly request: unknown }
  | { readonly t: "log"; readonly level: "debug" | "info" | "warn" | "error"; readonly message: string }
  | { readonly t: "drained" };

export function encodeFrame(frame: HostFrame | ChildFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Frames arrive split across chunk boundaries, so a decoder that assumes one
 * chunk is one frame works in tests and corrupts under load. This one buffers.
 */
export class FrameDecoder<T> {
  private buffer = "";

  push(chunk: string): readonly T[] {
    this.buffer += chunk;
    const frames: T[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      try {
        frames.push(JSON.parse(line) as T);
      } catch {
        // A malformed line is dropped rather than thrown: the peer is untrusted,
        // and one bad frame must not tear down a channel that is still carrying
        // valid ones. The caller notices via the missing reply and its timeout.
      }
    }
    return frames;
  }
}

/** The effect request shapes the host knows how to mediate. */
export interface FileReadRequest {
  readonly path: string;
}

export interface NetworkRequest {
  readonly url: string;
}
