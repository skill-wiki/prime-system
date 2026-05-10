# hand-authored .prime fixtures

Realistic hand-written `.prime` sources — used to test that the parser +
L1 + L2-heuristic behave sensibly on genuinely authored content, not
just on the simple shape produced by `scripts/yaml-to-prime.ts`.

These fixtures deliberately exercise language features the migration
doesn't use: nested objects, `requires` / `contradicts` / `specializes`
links of various shapes, `@safe` and other decorators, and longer
free-form claims.

The `e2e-integration.test.ts` suite (packages/compiler/test/) pulls one
Knowledge + two Rule fixtures through the full parse → L1 → L2 → L3 →
resolve → emit → graph → search → bundle pipeline and asserts the
expected behaviour at every stage.
