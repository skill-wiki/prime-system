/**
 * @module auth
 *
 * Access control for the HTTP surface.
 *
 * The design rule this module exists to enforce is that **the network cannot name
 * its own principal**. `QueryRequest.principal` is the engine's entire ACL input
 * (`query-engine/src/types.ts`: `allowedVisibility` + `grantedPolicyLabels`), and
 * admission runs before candidate generation, so a caller able to put a principal
 * in a request body would be able to read every `private` unit and every
 * policy-labelled unit in the corpus by asking. Therefore:
 *
 * - a credential maps to a principal *server-side*, and
 * - a request body carrying a `principal` key is **rejected**, not overridden.
 *
 * Rejecting rather than silently overriding is the deliberate choice. An override
 * leaves a caller believing a field it sent had an effect, and the day someone
 * moves the override one line later than a read of `body.principal` it becomes a
 * privilege escalation. A 400 cannot rot that way.
 *
 * There is no anonymous mode and no `--insecure` flag. A deployment with no
 * credentials configured does not start (see `./server.ts`), because the failure
 * this guards against is not "someone typed the wrong flag", it is "an
 * unauthenticated query surface over a whole corpus was left listening and nobody
 * noticed".
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Principal } from "@skill-wiki/query-engine";

export const AUTHORIZATION_HEADER = "authorization";
export const BEARER_PREFIX = "Bearer ";

/** The smallest token this module will accept. Shorter is not a secret. */
export const MIN_TOKEN_LENGTH = 32;

export interface Credential {
  /** Shared secret presented as `Authorization: Bearer <token>`. */
  readonly token: string;
  /**
   * What the bearer of that token is, in engine terms. Supplied by the operator,
   * never derived here: this package holds no visibility policy and no label
   * vocabulary, and a default like "public only" would be a policy decision made
   * by a transport.
   */
  readonly principal: Principal;
}

export type AuthOutcome =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly status: 401 | 403; readonly reason: string };

export interface Authenticator {
  /** Number of configured credentials. Read by the server's fail-closed startup check. */
  readonly credentialCount: number;
  authenticate(headers: Headers): AuthOutcome;
}

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

/**
 * Compares two secrets without leaking their relationship through timing.
 *
 * The digest step is not decoration: `timingSafeEqual` throws on
 * different-length inputs, so comparing raw tokens would reveal the expected
 * length through the error path. Hashing first makes every comparison a
 * fixed-width 32-byte one.
 */
function secretsEqual(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function createBearerAuthenticator(credentials: readonly Credential[]): Authenticator {
  if (credentials.length === 0) {
    throw new AuthConfigurationError(
      "An HTTP authenticator with no credentials would accept nothing and protect nothing; configure at least one credential.",
    );
  }
  for (const credential of credentials) {
    if (credential.token.length < MIN_TOKEN_LENGTH) {
      throw new AuthConfigurationError(
        `A bearer token must be at least ${MIN_TOKEN_LENGTH} characters; received one of ${credential.token.length}.`,
      );
    }
    if (credential.principal.id.length === 0) {
      throw new AuthConfigurationError("Every credential must name a non-empty principal id.");
    }
  }
  const seen = new Set(credentials.map(credential => credential.token));
  if (seen.size !== credentials.length) {
    throw new AuthConfigurationError("Two credentials share a token, so one principal's authority is unreachable.");
  }

  return {
    credentialCount: credentials.length,
    authenticate: (headers: Headers): AuthOutcome => {
      const header = headers.get(AUTHORIZATION_HEADER);
      if (header === null) return { ok: false, status: 401, reason: "missing Authorization header" };
      if (!header.startsWith(BEARER_PREFIX)) {
        return { ok: false, status: 401, reason: "Authorization header must use the Bearer scheme" };
      }
      const presented = header.slice(BEARER_PREFIX.length);
      // Every credential is compared even after a match, so the number of
      // comparisons does not depend on which token was presented.
      let matched: Principal | undefined;
      for (const credential of credentials) {
        if (secretsEqual(presented, credential.token)) matched = credential.principal;
      }
      if (matched === undefined) return { ok: false, status: 403, reason: "unrecognised bearer token" };
      return { ok: true, principal: matched };
    },
  };
}

/**
 * Reads credentials from the environment as `<token>:<principalId>:<visibilities>:<labels>`,
 * entries separated by newlines or semicolons.
 *
 * Environment rather than a config file so a token never has to be written to
 * disk next to the bundle it grants access to. The visibility and label lists are
 * required, not defaulted: an operator who does not state what a token may see
 * has not finished configuring it, and the safest-looking default (`public`) is
 * still a decision this package must not make on their behalf.
 */
export function parseCredentialSpec(spec: string): readonly Credential[] {
  const entries = spec.split(/[\n;]+/).map(line => line.trim()).filter(line => line.length > 0);
  return entries.map((entry, index) => {
    const parts = entry.split(":");
    if (parts.length !== 4) {
      throw new AuthConfigurationError(
        `Credential ${index + 1} must be '<token>:<principalId>:<visibility,…>:<label,…>'; found ${parts.length} field(s).`,
      );
    }
    const [token, principalId, visibility, labels] = parts as [string, string, string, string];
    const allowed = visibility.split(",").map(v => v.trim()).filter(v => v.length > 0);
    if (allowed.length === 0) {
      throw new AuthConfigurationError(`Credential ${index + 1} states no visibility, so it could observe nothing.`);
    }
    for (const value of allowed) {
      if (value !== "private" && value !== "shared" && value !== "public") {
        throw new AuthConfigurationError(
          `Credential ${index + 1} names visibility '${value}', which is not one of private/shared/public.`,
        );
      }
    }
    return {
      token,
      principal: {
        id: principalId,
        allowedVisibility: allowed as readonly ("private" | "shared" | "public")[],
        grantedPolicyLabels: labels.split(",").map(l => l.trim()).filter(l => l.length > 0),
      },
    };
  });
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}
