import type { QueryResult } from "./query-response";

export interface QueryAtom {
  id: string;
  kind: string;
  description?: string;
  tokens?: number;
}

export interface QueryMeta {
  relations?: Array<{ type: string; target: string }>;
}

export interface QueryArguments {
  scope: "atoms" | "related" | "show";
  query?: string;
  id?: string;
  level?: "summary" | "core" | "full";
  kind?: string;
  limit?: number;
}

export interface QueryEngineOptions {
  atoms: Iterable<QueryAtom>;
  kindBoosts?: Record<string, number>;
  domainTags?: ReadonlySet<string>;
  loadMeta(id: string): QueryMeta | undefined;
  resolveProjection(id: string, level: "summary" | "core" | "full"): string | undefined;
}

export type QueryEngineOutcome =
  | { results: QueryResult[] }
  | { error: string };

function scoreAtom(
  atom: QueryAtom,
  query: string,
  kindBoosts: Record<string, number>,
  domainTags: ReadonlySet<string>,
): number {
  if (!query) return 0.5;
  const blob = `${atom.id} ${atom.kind} ${atom.description ?? ""}`.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (blob.includes(token)) score += 1;
    if (atom.id.toLowerCase().includes(token)) score += 0.5;
  }
  // Preserve the original corpus-wide, domain-declared query tag lift.
  if (tokens.some((token) => domainTags.has(token))) score += 0.5;
  return score + (kindBoosts[atom.kind] ?? 0);
}

function resultFor(
  atom: QueryAtom,
  level: "summary" | "core" | "full",
  resolveProjection: QueryEngineOptions["resolveProjection"],
): QueryResult | null {
  const path = resolveProjection(atom.id, level);
  if (!path) return null;
  return {
    id: atom.id,
    kind: atom.kind,
    description: atom.description ?? "",
    tokens: atom.tokens ?? 0,
    level,
    path,
  };
}

/** Execute the existing generic prime_query semantics without transport state. */
export function executePrimeQuery(args: QueryArguments, options: QueryEngineOptions): QueryEngineOutcome {
  const atoms = [...options.atoms];
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  const level = args.level ?? "core";
  const limit = args.limit ?? 10;
  const kindBoosts = options.kindBoosts ?? {};
  const domainTags = options.domainTags ?? new Set<string>();

  if (args.scope === "atoms") {
    const results = atoms
      .filter((atom) => !args.kind || atom.kind === args.kind)
      .map((atom) => ({ atom, score: scoreAtom(atom, args.query ?? "", kindBoosts, domainTags) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .flatMap(({ atom }) => {
        const result = resultFor(atom, level, options.resolveProjection);
        return result ? [result] : [];
      });
    return { results };
  }

  if (args.scope === "show") {
    if (!args.id) return { error: "scope=show requires `id`." };
    const atom = byId.get(args.id);
    if (!atom) return { error: `Atom not found: ${args.id}` };
    const result = resultFor(atom, level, options.resolveProjection);
    return { results: result ? [result] : [] };
  }

  if (!args.id) return { error: "scope=related requires `id`." };
  if (!byId.has(args.id)) return { error: `Atom not found: ${args.id}` };
  const meta = options.loadMeta(args.id);
  if (!meta) return { error: `Atom not found: ${args.id}` };
  const seen = new Set<string>([args.id]);
  const results: QueryResult[] = [];
  for (const edge of meta.relations ?? []) {
    if (seen.has(edge.target)) continue;
    seen.add(edge.target);
    const target = byId.get(edge.target);
    if (!target || (args.kind && target.kind !== args.kind)) continue;
    const result = resultFor(target, level, options.resolveProjection);
    if (result) results.push({ ...result, description: `[${edge.type}] ${result.description}` });
    if (results.length >= limit) break;
  }
  return { results };
}
