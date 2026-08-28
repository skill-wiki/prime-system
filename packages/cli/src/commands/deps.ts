/**
 * prime deps <@scope/name> — Recursively walk dependency graph and print tree.
 *
 * Dependency edges walked (in order of weight):
 *   composition.must-include     (hard deps)
 *   related                      (soft, depth limited)
 *   composition.must-avoid        (exclusions, listed only)
 *
 * Edge verbs are the 14 declared in PRIME-PROTOCOL-v1.md §2:
 *   related, compatible, conflicts, see-also, extends, derived-from,
 *   requires, enhances, validates-with, supplies-to, specializes,
 *   contradicts, relationships, includes.
 *
 * Options:
 *   --depth <n>    Max recursion depth (default: 3)
 *   --related      Also recurse into `related` (default: false — listed flat)
 *   --dir <path>   Override default sources directory
 *   --json         Emit JSON adjacency list instead of tree
 */

import { bold, green, cyan, yellow, gray, red, magenta } from '../utils/display';
import { loadAtom, resolveAtomPath, DEFAULT_SOURCES_DIR, AtomMeta } from './registry';

export async function depsCommand(args: string[]): Promise<void> {
  let id: string | undefined;
  let sourcesDir = DEFAULT_SOURCES_DIR;
  let maxDepth = 3;
  let walkRelated = false;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) sourcesDir = args[++i];
    else if (args[i] === '--depth' && args[i + 1]) maxDepth = parseInt(args[++i], 10) || 3;
    else if (args[i] === '--related') walkRelated = true;
    else if (args[i] === '--json') jsonMode = true;
    else if (!args[i].startsWith('-')) id = args[i];
  }

  if (!id) {
    console.error('Usage: prime deps <@scope/name> [--depth 3] [--related] [--json]');
    process.exit(1);
  }

  const root = loadAtom(id, sourcesDir);
  if (!root) {
    console.error(`Atom '${id}' not found in ${sourcesDir}`);
    process.exit(1);
  }

  if (jsonMode) {
    const graph = buildGraph(root, sourcesDir, maxDepth, walkRelated);
    console.log(JSON.stringify(graph, null, 2));
    return;
  }

  // Print header
  console.log(`\n${bold('Dependency tree')}  ${gray(`(depth ≤ ${maxDepth})`)}`);
  console.log(`${gray('Legend:')}  ${green('+')} must-include   ${gray('·')} related   ${red('✕')} must-avoid`);
  console.log();

  const visited = new Set<string>();
  printTree(root, sourcesDir, '', true, 0, maxDepth, walkRelated, visited);

  console.log();
}

// ─── Tree printer ────────────────────────────────────────

/**
 * The display roles this printer distinguishes — not a relation vocabulary.
 *
 * This union used to also list 13 model-declared relation names. None of them
 * was ever constructed: the only values reaching `printTree` come from
 * `atom.mustInclude` / `atom.related` / `atom.mustAvoid` below, and `edgePrefix`
 * sends everything except these four to one default marker. So the relation
 * names were unreachable union members duplicating the model's closed set, and
 * listing them here is what plan §3.1 forbids. `related` survives as the name
 * of a *marker role*, keyed off `AtomMeta.related`, not off a relation verb.
 */
type EdgeKind = 'root' | 'must-include' | 'must-avoid' | 'related';

function edgePrefix(kind: EdgeKind): string {
  switch (kind) {
    case 'must-include': return green('+');
    case 'must-avoid':   return red('✕');
    case 'related':      return gray('·');
    default:             return cyan('~');
  }
}

function printTree(
  atom: AtomMeta,
  sourcesDir: string,
  prefix: string,
  isLast: boolean,
  depth: number,
  maxDepth: number,
  walkRelated: boolean,
  visited: Set<string>,
  edgeKind: EdgeKind = 'root'
) {
  const connector = depth === 0 ? '' : isLast ? '└── ' : '├── ';
  const marker = edgePrefix(edgeKind);
  const label = depth === 0
    ? bold(atom.id) + '  ' + gray(`(${atom.kind})`)
    : `${marker} ${atom.id}  ${gray(`(${atom.kind} v${atom.version})`)}`;

  console.log(`${prefix}${connector}${label}`);

  if (visited.has(atom.id)) {
    const childPrefix = prefix + (depth === 0 ? '' : isLast ? '    ' : '│   ');
    console.log(`${childPrefix}    ${gray('(already expanded above)')}`);
    return;
  }
  visited.add(atom.id);

  if (depth >= maxDepth) return;

  const childPrefix = prefix + (depth === 0 ? '' : isLast ? '    ' : '│   ');

  // Build child edges (protocol edge verbs only — no domain-specific extras)
  const edges: Array<{ ref: string; kind: EdgeKind }> = [
    ...atom.mustInclude.map(r => ({ ref: r, kind: 'must-include' as EdgeKind })),
    ...(walkRelated ? atom.related.map(r => ({ ref: r, kind: 'related' as EdgeKind })) : []),
    ...atom.mustAvoid.map(r => ({ ref: r, kind: 'must-avoid' as EdgeKind })),
  ];

  // Deduplicate keeping first occurrence
  const seen = new Set<string>();
  const uniqueEdges = edges.filter(e => {
    if (seen.has(e.ref)) return false;
    seen.add(e.ref);
    return true;
  });

  // If not walking related, still list them flat at depth 0
  if (!walkRelated && depth === 0 && atom.related.length > 0) {
    const relEdges = atom.related.filter(r => !seen.has(r));
    if (relEdges.length > 0) {
      uniqueEdges.push(...relEdges.map(r => ({ ref: r, kind: 'related' as EdgeKind })));
    }
  }

  for (let i = 0; i < uniqueEdges.length; i++) {
    const { ref, kind } = uniqueEdges[i];
    const last = i === uniqueEdges.length - 1;
    const child = loadAtom(ref, sourcesDir);

    if (!child) {
      const connector2 = last ? '└── ' : '├── ';
      const marker2 = edgePrefix(kind);
      console.log(`${childPrefix}${connector2}${marker2} ${ref}  ${yellow('⚠ NOT FOUND')}`);
      continue;
    }

    printTree(child, sourcesDir, childPrefix, last, depth + 1, maxDepth, walkRelated, visited, kind);
  }
}

// ─── JSON graph builder ──────────────────────────────────

interface GraphNode {
  id: string;
  kind: string;
  version: string;
  found: boolean;
  mustInclude: string[];
  related: string[];
  mustAvoid: string[];
}

function buildGraph(
  root: AtomMeta,
  sourcesDir: string,
  maxDepth: number,
  walkRelated: boolean
): Record<string, GraphNode> {
  const graph: Record<string, GraphNode> = {};
  const queue: Array<{ id: string; depth: number }> = [{ id: root.id, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (graph[id]) continue;

    const atom = loadAtom(id, sourcesDir);
    if (!atom) {
      graph[id] = { id, kind: 'unknown', version: '?', found: false, mustInclude: [], related: [], mustAvoid: [] };
      continue;
    }

    graph[id] = {
      id: atom.id,
      kind: atom.kind,
      version: atom.version,
      found: true,
      mustInclude: atom.mustInclude,
      related: atom.related,
      mustAvoid: atom.mustAvoid,
    };

    if (depth < maxDepth) {
      const refs = [
        ...atom.mustInclude,
        ...(walkRelated ? atom.related : []),
      ];
      for (const ref of refs) {
        if (!graph[ref]) queue.push({ id: ref, depth: depth + 1 });
      }
    }
  }

  return graph;
}
