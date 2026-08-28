import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

/**
 * A projection `include` list mixes two namespaces that the protocol currently
 * cannot tell apart:
 *
 *   1. schema field selectors — must resolve to a declared field of the type;
 *   2. renderer section names — dispatch to an appender function in the
 *      compiler's chunker, and are deliberately loose across a type group.
 *
 * `ProjectionDefinitionSchema` has no syntax for the distinction, so a checker
 * that treats every unresolved selector as a schema error reports data defects
 * that are not there. Until the schema gains that expression (plan §5.5 gap),
 * the second namespace is supplied as data and reported separately.
 */

const RendererSectionsSchema = z.object({
  kind: z.literal("renderer-sections"),
  name: z.string().min(1),
  sections: z.array(z.string().min(1)).min(1),
  /** section name -> additional field spellings its appender accepts. */
  fieldAliases: z.record(z.string(), z.array(z.string().min(1))).default({}),
}).strict();

export interface RendererSections {
  readonly name: string;
  /** Section names plus every accepted alias, for membership tests. */
  readonly names: ReadonlySet<string>;
}

export const DEFAULT_RENDERER_SECTIONS_PATH = join(
  dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "renderer-sections", "chunker-v1.yaml",
);

export function loadRendererSections(path: string = DEFAULT_RENDERER_SECTIONS_PATH): RendererSections {
  const parsed = RendererSectionsSchema.parse(parse(readFileSync(resolve(path), "utf8")));
  const names = new Set<string>(parsed.sections);
  for (const [section, aliases] of Object.entries(parsed.fieldAliases)) {
    names.add(section);
    for (const alias of aliases) names.add(alias);
  }
  return { name: parsed.name, names };
}

/** Empty set when the data file is absent, so the checker degrades to "all schema errors". */
export function defaultRendererSections(): RendererSections {
  return existsSync(DEFAULT_RENDERER_SECTIONS_PATH)
    ? loadRendererSections()
    : { name: "none", names: new Set<string>() };
}
