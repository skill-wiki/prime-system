/**
 * The Action half of plan §10.2, driven through the transport against a real
 * `ActionRuntime` over the real `security-model` Model Package. It is here rather
 * than in `action-runtime`'s own suite because what is being checked is that the
 * client adds nothing: authorization, capability checks and idempotency all still
 * decide the outcome when the call arrives via `AoeClient`.
 */

import { describe, expect, test } from "bun:test";
import {
  ActionProviderRegistry,
  ActionRuntime,
  InMemoryEventStore,
  type RequestContext,
} from "@skill-wiki/action-runtime";
import { loadModelOrThrow } from "@skill-wiki/model-schema";
import { createEmbeddedTransport, AoeClient } from "../src/index.ts";
import { loadEngineContext, MODEL_ROOT, registry, SNAPSHOT } from "./support/host.ts";

const model = loadModelOrThrow(MODEL_ROOT);

function client(options: { readonly allowedCapabilities: readonly string[] }) {
  const events = new InMemoryEventStore();
  const actions = new ActionProviderRegistry().register("audit-runner", {
    async execute(input: unknown) {
      const control = (input as { readonly control: { readonly name: string } }).control;
      return { name: `assessment of ${control.name}`, verdict: "satisfied", assessedControl: control };
    },
  });
  const runtime = new ActionRuntime(model, {
    actions,
    events,
    authorizer: { authorize: async () => ({ allowed: true, reason: "test authorizer" }) },
  });
  const transport = createEmbeddedTransport({
    snapshot: SNAPSHOT,
    engine: loadEngineContext(),
    generators: registry(),
    actions: runtime,
  });
  const context: RequestContext = {
    principal: "auditor",
    roles: ["auditor"],
    allowedCapabilities: [...options.allowedCapabilities],
    budget: {},
    snapshot: SNAPSHOT.corpusRelease,
    trace: "trace-1",
  };
  return { client: new AoeClient({ transport }), context };
}

const CONTROL = { name: "multi factor", statement: "require a second factor", automated: true };

describe("actions over the embedded transport", () => {
  test("a read-only action with its capability granted really executes end to end", async () => {
    const { client: aoe, context } = client({ allowedCapabilities: ["corpus.read"] });
    const run = await aoe.execute({
      action: "AuditControl",
      input: { control: CONTROL },
      context,
      idempotencyKey: "audit-1",
    });
    expect(run.status).toBe("succeeded");
    expect(run.output).toEqual({
      name: "assessment of multi factor",
      verdict: "satisfied",
      assessedControl: CONTROL,
    });
    expect((await aoe.events(run.id)).length).toBeGreaterThan(0);
  });

  test("preflight reports the model's declared effect surface, not the client's guess", async () => {
    const { client: aoe, context } = client({ allowedCapabilities: ["corpus.read"] });
    const effect = await aoe.preflight({
      action: "AuditControl",
      input: { control: CONTROL },
      context,
      idempotencyKey: "audit-2",
    });
    expect(effect.sideEffects).toBe("read");
    expect(effect.requiredCapabilities).toEqual(["corpus.read"]);
    expect(effect.approval).toBe("none");
  });

  test("the capability check still decides when the call arrives through the client", async () => {
    const { client: aoe, context } = client({ allowedCapabilities: [] });
    const run = await aoe.execute({
      action: "AuditControl",
      input: { control: CONTROL },
      context,
      idempotencyKey: "audit-3",
    });
    // A denial is a terminal *run*, not a thrown error — that is `action-runtime`'s
    // decision, and the client preserving it is the point of this assertion: a
    // client that turned it into a rejection would lose the auditable run.
    expect(run.status).toBe("denied");
    expect(run.error).toBe("Capability denied: corpus.read");
  });

  test("idempotency still collapses a replay through the client", async () => {
    const { client: aoe, context } = client({ allowedCapabilities: ["corpus.read"] });
    const first = await aoe.execute({
      action: "AuditControl",
      input: { control: CONTROL },
      context,
      idempotencyKey: "audit-4",
    });
    const replay = await aoe.execute({
      action: "AuditControl",
      input: { control: CONTROL },
      context,
      idempotencyKey: "audit-4",
    });
    expect(replay.id).toBe(first.id);
  });
});
