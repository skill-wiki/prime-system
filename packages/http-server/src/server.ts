/**
 * @module server
 *
 * Binding the handler to a socket.
 *
 * Two decisions are enforced here rather than left to a caller:
 *
 * - **Loopback by default.** `hostname` defaults to `127.0.0.1`. Binding
 *   elsewhere requires `acknowledgeNonLoopbackExposure: true` — a name a caller
 *   cannot pass by accident and cannot read as a performance or convenience knob.
 * - **No unauthenticated listener, ever.** The authenticator is a required field
 *   and `createBearerAuthenticator` refuses to build with zero credentials, so
 *   there is no path from this function to a listening socket that answers
 *   `/v1/query` without a credential.
 *
 * `Bun.serve` is used directly. The alternative — `node:http` — would need its own
 * `IncomingMessage` → `Request` adapter, and that adapter would be a second place
 * where a header could be read differently from how the handler's tests read it.
 */

import type { Tracer } from "@skill-wiki/observability";
import { isLoopbackHost, type Authenticator } from "./auth.ts";
import { createRequestHandler, type HandlerOptions } from "./handler.ts";

export class ServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigurationError";
  }
}

export interface ServeOptions extends HandlerOptions {
  /** Defaults to `127.0.0.1`. */
  readonly hostname?: string;
  /** Defaults to `0`, which asks the OS for a free port — the right default for a test. */
  readonly port?: number;
  /**
   * Required to bind anything but loopback. Spelled as an acknowledgement rather
   * than as `allowRemote` so the call site records that a human decided to expose
   * a corpus query surface to a network.
   */
  readonly acknowledgeNonLoopbackExposure?: boolean;
}

export interface RunningServer {
  readonly hostname: string;
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * Validates the exposure decision without binding anything.
 *
 * Separate from `startServer` so the rule is testable and so a CLI can fail before
 * it has a socket to clean up.
 */
export function assertBindable(options: {
  readonly hostname: string;
  readonly authenticator: Authenticator;
  readonly acknowledgeNonLoopbackExposure?: boolean;
}): void {
  if (options.authenticator.credentialCount === 0) {
    throw new ServerConfigurationError("Refusing to listen with no credentials configured.");
  }
  if (!isLoopbackHost(options.hostname) && options.acknowledgeNonLoopbackExposure !== true) {
    throw new ServerConfigurationError(
      `Refusing to bind '${options.hostname}': it is not a loopback address. Pass acknowledgeNonLoopbackExposure: true to expose this corpus query surface beyond this machine.`,
    );
  }
}

interface BunServerLike {
  readonly hostname: string;
  readonly port: number;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

interface BunLike {
  serve(options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Promise<Response>;
  }): BunServerLike;
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  assertBindable({
    hostname,
    authenticator: options.authenticator,
    ...(options.acknowledgeNonLoopbackExposure === undefined
      ? {}
      : { acknowledgeNonLoopbackExposure: options.acknowledgeNonLoopbackExposure }),
  });

  const runtime = (globalThis as { Bun?: BunLike }).Bun;
  if (runtime === undefined) {
    throw new ServerConfigurationError(
      "startServer needs a Bun runtime; use createRequestHandler directly to mount this API on another server.",
    );
  }

  const handler = createRequestHandler(options);
  const server = runtime.serve({ hostname, port: options.port ?? 0, fetch: handler });
  return {
    hostname: server.hostname,
    port: server.port,
    url: `http://${server.hostname}:${server.port}`,
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  };
}

/** Exported so a caller can log what will be observed before the socket opens. */
export function describeExposure(options: { readonly hostname: string; readonly tracer?: Tracer }): string {
  return isLoopbackHost(options.hostname)
    ? `bound to ${options.hostname}: reachable only from this machine`
    : `bound to ${options.hostname}: reachable from the network — every request still needs a bearer credential`;
}
