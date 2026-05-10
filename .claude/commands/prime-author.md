---
description: Scaffold a new .prime source file for a given kind and name
argument-hint: <kind> <name>
allowed-tools: Read, Write, Bash
---

The user wants to author a new Prime atom. Arguments:

> $ARGUMENTS

The first token is the atom **kind** (e.g. `fact`, `rule`, `pattern`, `persona`, `voice`). The rest is the **name** in kebab-case.

Do this:

1. Read `/Users/houxianchao/Desktop/prime/release/prime-system/docs/dsl-quickref.md` to confirm the exact field set, required fields, and edge verbs valid for this kind. Do not guess from memory — kinds drift.
2. Before writing the file, ask the user **3 short clarifying questions** tailored to the kind. For a `rule` ask about scope, trigger, and exceptions; for a `pattern` ask about the problem, the shape, and the anti-pattern it replaces; for a `voice` ask about register, tense, and forbidden moves. Wait for answers.
3. Once answered, create `<kind>-<name>.prime` in the user's current working directory. Scaffold:
   - the kind block with `id: "@<corpus>/<kind>-<name>"` (ask which corpus if unclear)
   - `version: "0.1.0"`
   - every required field for the kind, pre-filled from the user's answers
   - optional fields as commented stubs the user can uncomment
   - one or two `related:` / `requires:` edge slots, empty, ready to wire
4. Print the new file path and remind the user to run `/prime-compile` on the parent directory to type-check it.
