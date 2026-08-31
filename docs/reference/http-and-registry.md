# HTTP and Registry

The HTTP server delegates snapshot, plan, query, and resource operations to the
same engine transport used by the SDK. It adds network-boundary concerns, not
domain semantics.

## HTTP security contract

- Every route except `/healthz` requires a bearer credential.
- The server derives the principal from that credential. A request body cannot
  choose its own principal.
- The server binds loopback by default. Non-loopback exposure requires an
  explicit acknowledgement.
- TLS termination, rate limiting, and deployment request-size limits belong in
  the surrounding infrastructure and must be configured for remote use.

The package exposes health, snapshot, plan, query, and single-projection resource
operations. Action and event capabilities use the SDK/action runtime contracts;
do not add a handwritten domain route.

## Registry

The Registry discovers and distributes Model, Corpus, Adapter, Domain, and Plugin
Packages. A registry record must preserve package kind, version, digest,
compatibility, provenance, and signature metadata.

The current remote and `@skill-wiki/*` package names are compatibility locations.
Documentation must not claim a `kernary.dev` registry or `@kernary/*` publication
until those external services exist and a round-trip publish/install check passes.
