# HTTP and Registry

Use the HTTP transport when an Agent, web application, or service needs to use
AOE from another process. Use a Registry when teams need to discover and
distribute the packages that make up a domain.

## HTTP service

The server exposes the same contract as the embedded SDK:

```text
health · snapshot · plan · query · resource
                         │
                 preflight · execute · events
```

It delegates Model and Corpus semantics to the Engine. A handwritten domain
route is not required for each new package.

### Security defaults

- Every route except `/healthz` requires a bearer credential.
- The principal comes from that credential; a request body cannot choose it.
- The server binds to loopback by default.
- Non-loopback exposure requires an explicit acknowledgement.
- TLS termination, rate limiting, request-size limits, and network policy belong
  in the surrounding deployment infrastructure.

Before exposing the service remotely, bind authentication to a Request Context
with tenant and workspace identity. Register only the Action providers that the
deployment is prepared to authorize and observe.

## Registry service

A Registry is a catalogue and distribution point for:

- Model Packages;
- Corpus Packages;
- Adapter Packages;
- Domain Packages;
- Plugin Packages.

Each record should include package kind, name, version, digest, provenance,
licence, visibility, and signature metadata. Installation resolves an immutable
release; it must not rewrite the package's Model or Corpus semantics.

The static website currently provides package discovery and source links. A
hosted Registry is a separately deployed service that implements this contract.
The [package model](../concepts/package-model.md) explains which data belongs in
each package before it is published.
