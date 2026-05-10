---
description: Compile a corpus and prep a draft PR against skill-wiki.github.io
argument-hint: <source dir>
allowed-tools: Bash, Read
---

The user wants to compile a Prime corpus and prepare to publish it to the public registry at `skill-wiki.github.io`. Source directory:

> $ARGUMENTS

Do this:

1. Run the compiler:

   ```
   bun /Users/houxianchao/Desktop/prime/release/prime-system/packages/cli/src/index.ts compile --dir $ARGUMENTS --out compiled/
   ```

   If the build fails, stop and report the error. Do not proceed to publish a broken corpus.
2. Confirm `compiled/_index.xml` was written. If missing, the build is incomplete — abort.
3. Read the corpus manifest (e.g. `prime.toml` or top-level metadata in the source tree) to extract: `name`, `version`, `description`, `kinds`, `atom-count`. If those aren't recorded, derive `atom-count` and `kinds` from `_index.xml`.
4. Print the YAML block the user needs to paste into `data/skills.yaml` on skill-wiki.github.io. Format:

   ```yaml
   - name: <name>
     version: <version>
     description: <one line>
     kinds: [<kind list>]
     atoms: <count>
     repo: <repo-url-if-known>
   ```

5. Print the GitHub edit URL: `https://github.com/skill-wiki/skill-wiki.github.io/edit/main/data/skills.yaml`
6. Tell the user to paste the YAML, commit on a branch, and open a PR. Do not push or open the PR yourself unless they ask.
