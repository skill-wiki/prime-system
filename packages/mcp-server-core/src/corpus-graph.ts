/**
 * The v1 atom-directory bundle, read as the IR the generic engines consume.
 *
 * `@aoe/runtime` hands us `GlobalIndexAtom` (from `_index.xml`) and
 * `AtomMeta` (from `atom.yaml`); `@aoe/query-engine` and
 * `@aoe/projection-engine` consume `UnitIR`/`GraphIR`. Nothing in the repo
 * bridged the two, so this module is that bridge and nothing else: it performs no
 * ranking, no filtering and no policy.
 *
 * Two rules keep it domain-free:
 *
 *  - `typeRef` is the atom's own `kind` string, matched against the Model
 *    Package's type names. No kind is enumerated here.
 *  - `fields` keys are the *own property names of the loaded metadata object*,
 *    discovered at runtime. Naming them in TypeScript would put the corpus schema
 *    back into the engine, and the lexical generator only needs reachable strings.
 */

import type {
  DiagnosticIR,
  GraphEdgeIR,
  GraphIR,
  SnapshotRef,
  TypedValueIR,
  UnitIR,
  ValueIR,
} from "@aoe/ir";

/** The metadata shape this adapter needs, structurally satisfied by `AtomMeta`. */
export interface AtomMetaLike {
  readonly id: string;
  readonly kind: string;
  readonly version: string;
  readonly contentHash: string;
  readonly relations: readonly { readonly type: string; readonly target: string }[];
  readonly projection: Readonly<Record<string, string>>;
  readonly deprecated_at?: string;
}

/** The index entry shape this adapter needs, structurally satisfied by `GlobalIndexAtom`. */
export interface IndexAtomLike {
  readonly id: string;
  readonly kind: string;
  readonly description: string;
  readonly tokens: number;
}

export interface CorpusGraphOptions {
  readonly atoms: Iterable<IndexAtomLike>;
  readonly loadMeta: (id: string) => AtomMetaLike;
  readonly snapshot: SnapshotRef;
  readonly corpus: string;
}

export interface CorpusGraph {
  readonly graph: GraphIR;
  /** Level name → bundle-relative artifact path, per unit. */
  readonly artifacts: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** Per-level token counts as measured by the compiler, per unit. */
  readonly tokenCosts: ReadonlyMap<string, Readonly<Record<string, number>>>;
  /**
   * The `fields` key the human-readable summary text landed under, discovered
   * from the data rather than named here so the response formatter does not have
   * to know the corpus schema either.
   */
  readonly descriptionField?: string;
  readonly diagnostics: readonly DiagnosticIR[];
}

const ORIGIN = { loc: { line: 0, column: 0, offset: 0 } } as const;

function scalar(value: string | number | boolean): TypedValueIR {
  if (typeof value === "number") return { kind: "number", value, source: ORIGIN };
  if (typeof value === "boolean") return { kind: "boolean", value, source: ORIGIN };
  return { kind: "string", value, source: ORIGIN };
}

/**
 * Convert one own property into a `TypedValueIR`. Nested objects are skipped
 * rather than flattened: they are the structural slots this adapter already maps
 * explicitly (relations, per-level paths, per-level tokens), and copying them into
 * `fields` as well would double-count them in every lexical score.
 */
function fieldValue(value: unknown): TypedValueIR | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return scalar(value);
  }
  if (Array.isArray(value)) {
    const items = value.filter(
      (item): item is string | number | boolean =>
        typeof item === "string" || typeof item === "number" || typeof item === "boolean",
    );
    if (items.length !== value.length) return undefined;
    return { kind: "array", items: items.map(scalar), source: ORIGIN };
  }
  return undefined;
}

/**
 * Field keys come from the data, so the one key this adapter *adds* is derived
 * from an existing one rather than invented: the index body is a second rendering
 * of the metadata's own description slot.
 */
/**
 * The index body's own text, with any child markup removed.
 *
 * `runtime/src/atom-loader.ts` `parseIndexXml` takes the whole `<atom>` element
 * body as the description, and that body contains the `<edge/>` children. Copying
 * it verbatim into a field is an access-control leak, not just noise: an admitted
 * unit's description would then spell out the ids of its neighbours, including
 * ones the principal was denied. Text stops at the first child element.
 */
function indexBodyText(body: string): string {
  const firstElement = body.indexOf("<");
  return (firstElement === -1 ? body : body.slice(0, firstElement)).trim();
}

function unitFields(
  meta: AtomMetaLike,
  indexAtom: IndexAtomLike,
): { readonly fields: Readonly<Record<string, TypedValueIR>>; readonly descriptionField?: string } {
  const fields: Record<string, TypedValueIR> = {};
  for (const key of Object.keys(meta).sort()) {
    const converted = fieldValue((meta as unknown as Record<string, unknown>)[key]);
    if (converted !== undefined) fields[key] = converted;
  }
  // The index body carries text that `atom.yaml` may not; keep it addressable
  // under the index's own field name so no new vocabulary is introduced.
  const indexKey = Object.keys(indexAtom).find(
    (key) => (indexAtom as unknown as Record<string, unknown>)[key] === indexAtom.description,
  );
  if (indexKey === undefined) return { fields };
  const existing = fields[indexKey];
  const metaHasText = existing !== undefined && existing.kind === "string" && existing.value.trim() !== "";
  if (!metaHasText) {
    const text = indexBodyText(indexAtom.description);
    if (text !== "") fields[indexKey] = scalar(text);
    else if (existing !== undefined) delete fields[indexKey];
  }
  return { fields, descriptionField: indexKey };
}

/** Edge ids are stable and sortable so a graph digest does not depend on load order. */
function edgeId(from: string, relationRef: string, to: string): string {
  return `${from}|${relationRef}|${to}`;
}

function numberRecord(value: unknown): Readonly<Record<string, number>> {
  if (value === null || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number") out[key] = raw;
  }
  return out;
}

/**
 * Build the graph once, at boot. Every `atom.yaml` is read here rather than per
 * request because relation expansion needs the whole edge set before it can walk
 * anything, and because the server already performs all of its filesystem reads
 * at construction time.
 */
export function buildCorpusGraph(options: CorpusGraphOptions): CorpusGraph {
  const diagnostics: DiagnosticIR[] = [];
  const units: UnitIR[] = [];
  const artifacts = new Map<string, Readonly<Record<string, string>>>();
  const tokenCosts = new Map<string, Readonly<Record<string, number>>>();
  const pending: { readonly unitId: string; readonly edges: readonly GraphEdgeIR[] }[] = [];
  let descriptionField: string | undefined;

  for (const atom of options.atoms) {
    let meta: AtomMetaLike;
    try {
      meta = options.loadMeta(atom.id);
    } catch (error) {
      // A corpus whose index names an atom that has no readable metadata is a
      // data defect; the unit is dropped with a reason rather than half-built.
      diagnostics.push({
        code: "CORPUS_UNIT_METADATA_UNREADABLE",
        message: `${atom.id}: ${error instanceof Error ? error.message : String(error)}`,
        severity: "error",
      });
      continue;
    }

    const edges = meta.relations.map((relation) => ({
      id: edgeId(atom.id, relation.type, relation.target),
      relationRef: relation.type,
      from: atom.id,
      to: relation.target,
    }));
    pending.push({ unitId: atom.id, edges });

    // `atom.yaml` states a path relative to the *unit* directory, while the
    // containment check (§12.3) is relative to the bundle root. Joining here is
    // what makes the check meaningful instead of always failing.
    const bundleRelative: Record<string, string> = {};
    for (const [level, relative] of Object.entries(meta.projection)) {
      bundleRelative[level] = `${atom.id}/${relative}`;
    }
    artifacts.set(atom.id, bundleRelative);
    tokenCosts.set(atom.id, numberRecord((meta as unknown as Record<string, unknown>)["tokens"]));

    const built = unitFields(meta, atom);
    if (built.descriptionField !== undefined) descriptionField = built.descriptionField;

    units.push({
      identity: {
        id: atom.id,
        version: meta.version,
        digest: meta.contentHash,
        corpus: options.corpus,
      },
      typeRef: meta.kind,
      implements: [],
      fields: built.fields,
      relations: edges,
      citations: [],
      // The v1 atom directory declares neither policy labels nor visibility, so
      // there is nothing to narrow here. See the lane report: the ACL is wired and
      // enforced, but it has no data to act on until the format carries it.
      policyLabels: [],
      lifecycle: meta.deprecated_at === undefined ? "active" : "deprecated",
      visibility: "public",
      provenance: { source: ORIGIN },
      projections: { ...meta.projection } as Readonly<Record<string, ValueIR>>,
    });
  }

  // Drop dangling edges *after* the unit set is known. The previous
  // implementation dropped them implicitly by looking the target up in a map;
  // doing it explicitly is what lets the drop be reported.
  const known = new Set(units.map((unit) => unit.identity.id));
  const keptByUnit = new Map<string, GraphEdgeIR[]>();
  const allEdges: GraphEdgeIR[] = [];
  for (const entry of pending) {
    const kept: GraphEdgeIR[] = [];
    for (const edge of entry.edges) {
      if (!known.has(edge.to)) {
        diagnostics.push({
          code: "CORPUS_EDGE_DANGLING",
          message: `${edge.from} -[${edge.relationRef}]-> ${edge.to}: target is not an active unit in this snapshot`,
          severity: "warning",
        });
        continue;
      }
      kept.push(edge);
    }
    keptByUnit.set(entry.unitId, kept);
    allEdges.push(...kept);
  }

  const scrubbed = units.map((unit) => ({
    ...unit,
    relations: keptByUnit.get(unit.identity.id) ?? [],
  }));

  return {
    graph: {
      snapshot: options.snapshot,
      units: scrubbed,
      edges: allEdges,
      diagnostics,
      indexes: {},
    },
    artifacts,
    tokenCosts,
    ...(descriptionField === undefined ? {} : { descriptionField }),
    diagnostics,
  };
}
