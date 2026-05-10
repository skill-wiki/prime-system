---
description: Publish the current Prime corpus to the skill-wiki marketplace via an automated GitHub PR
argument-hint: [--description <text>] [--tags <a,b,c>]
allowed-tools: Bash, Read
---

The user wants to publish the Prime corpus in the cwd to the public Skill Wiki marketplace at `skill-wiki/skill-wiki.github.io`. Extra args, if any:

> $ARGUMENTS

Do this:

1. Verify the cwd has a `pack.yaml` and a compiled output directory (the `compiled:` subdir named in `pack.yaml`, or `compiled/` by default). If either is missing, stop and tell the user to run `prime compile` first.
2. Confirm `gh` is installed (`gh --version`) and authenticated (`gh auth status`). If not, instruct the user to run `gh auth login` and stop.
3. Run a dry-run first so the user sees the YAML that will be submitted:

   ```
   bun /Users/houxianchao/Desktop/prime/release/prime-system/packages/cli/src/index.ts publish-marketplace --dry-run $ARGUMENTS
   ```

   Show that output verbatim and ask the user to confirm before proceeding.
4. On confirmation, run the real flow:

   ```
   bun /Users/houxianchao/Desktop/prime/release/prime-system/packages/cli/src/index.ts publish-marketplace $ARGUMENTS
   ```

   This forks `skill-wiki/skill-wiki.github.io`, branches `add-<slug>`, appends the entry to `data/skills.yaml`, pushes to the user's fork, and opens a PR. Print the PR URL it returns.
5. Fallback if the CLI subcommand is unavailable: walk the user through the manual flow — `gh repo fork skill-wiki/skill-wiki.github.io`, edit `data/skills.yaml`, commit on a new branch, `gh pr create --repo skill-wiki/skill-wiki.github.io`. Use the schema in `data/skills.yaml` (slug, repo, compiledSubdir, description, homepage, maintainers, tags).

Do not push or open a PR without an explicit user confirmation after the dry-run.
