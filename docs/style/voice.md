# AOE documentation voice

Write like a builder explaining a system they are responsible for.

Start with the result, task, or boundary the reader needs. Use ordinary words
until a precise protocol term earns its place. Name limitations before they
surprise the reader. Prefer one checked example to a list of possible features.

The voice is calm and specific. It can make decisions and explain trade-offs,
but it does not need to defend every paragraph. Avoid trend introductions,
marketing superlatives, repeated “not X but Y” slogans, and internal worklog
language.

## By page type

- README and homepage: builder to builder; concrete and short.
- Tutorial and guide: the reader is doing something now; show prerequisites,
  commands, success, and recovery.
- Concept and ADR: explain the mental model, trade-offs, and durable boundary.
- Reference: signatures, fields, defaults, and errors; no story arc.
- Release note and essay: first person is allowed for real choices and evidence.

## Bilingual writing

English and Chinese share facts, examples, and terminology. They do not share
sentence structure. Rewrite transitions and paragraph rhythm in each language.
Keep identifiers and contract names in English when translation would create a
second technical vocabulary.

## Review questions

1. Who opens this page, and what can they do after reading it?
2. Which repository or command owns every changing fact?
3. Is a domain example being presented as a Core rule?
4. Can every command run, and what visible result proves success?
5. Does the page say what is unavailable or pending publication?
6. Can a paragraph be removed without losing a decision or instruction?
