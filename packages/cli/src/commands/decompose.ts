/**
 * `prime decompose <SKILL.md>` — pointer command.
 *
 * The earlier heuristic implementation (regex over `##` headings) shipped
 * placeholders that needed manual rewrites and gave a misleading "I just
 * decomposed your skill" impression. It was retired because the agent-driven
 * version — `skills/prime-decompose/` in this repo — produces dramatically
 * better atoms and matches the rest of the system's "agent-as-author" model.
 *
 * This command is kept as a pointer so users who type it discover the right
 * tool. It does not parse the SKILL or write any files.
 */

import { resolve, basename } from 'path';
import { header, info, error, bold, cyan, gray } from '../utils/display';
import { fileExists } from '../utils/fs';

export async function decomposeCommand(args: string[]): Promise<void> {
  const file = args[0];

  header('prime decompose');

  if (!file) {
    info('Usage: prime decompose <path-to-SKILL.md>');
    console.log();
  } else {
    const filePath = resolve(file);
    if (!fileExists(filePath)) {
      error(`File not found: ${filePath}`);
      process.exit(1);
    }
    console.log(`  ${bold('input')}  ${gray(filePath)}`);
    console.log(`  ${bold('source')} ${gray(`${basename(filePath)} — ready for the prime-decompose skill`)}`);
    console.log();
  }

  console.log(`  ${bold('How to decompose this Skill')}`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  Decomposition is performed by an agent driving the`);
  console.log(`  ${cyan('prime-decompose')} Claude Code skill (or any MCP-compatible`);
  console.log(`  client with file-system access).`);
  console.log();
  console.log(`  ${bold('Step 1.')} Read the skill spec:`);
  console.log(`    ${gray('skills/prime-decompose/SKILL.md')}`);
  console.log();
  console.log(`  ${bold('Step 2.')} In your agent client, ask:`);
  console.log(
    `    ${cyan(`"Use the prime-decompose skill to convert ${file ?? '<path>'} into atoms"`)}`,
  );
  console.log();
  console.log(`  ${bold('Step 3.')} Validate the output:`);
  console.log(`    ${gray('prime check <generated-atom-dir>')}`);
  console.log();
  info('Why no built-in regex decomposer?');
  console.log(
    `  Skill markdown is structured for humans, not parsers. Heuristic`,
  );
  console.log(
    `  decomposition consistently produces atoms that need manual rewrites.`,
  );
  console.log(
    `  An agent driving the skill produces shippable atoms; a regex does not.`,
  );
  console.log();
}
