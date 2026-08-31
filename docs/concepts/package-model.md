# Package model

Kernary keeps domain meaning outside the engine. A deployment is assembled from
packages with different ownership and release rules.

## Model Package

A Model Package declares the vocabulary and behavior of a domain:

- types and fields;
- relation direction, cardinality, traversal, selection, load order, conflict,
  and cycle behavior;
- projections and token targets;
- retrieval profiles, generators, features, constraints, and rerankers;
- functions, actions, capabilities, approval, and policies;
- validators and migrations.

The engine validates these declarations against a meta-schema. It does not
enumerate Ticket, Rule, SecurityControl, or any other production type.

## Corpus Package

A Corpus Package owns the material released against a model:

- source Units and assets;
- corpus identity and compatible model range;
- provenance and licence metadata;
- visibility and publication policy;
- evaluation fixtures;
- release and signing configuration.

Compiled output is not source. `_index.xml`, Unit projections,
`corpus.manifest.json`, signatures, and `model.lock` are generated artifacts.

## Adapter and Domain Packages

An Adapter Package connects an external catalogue, API, validator, search
provider, or action provider. It cannot add domain semantics to Core.

A Domain Package composes a model, corpus, adapters, tools, and optional Agent
Skills into a maintained product boundary. Frontend Design is one Domain
Package. Its personas, six-axis retrieval, HTML validator, and Scout adapter
belong there.

## Why the split matters

Model and Corpus releases can move independently within declared compatibility.
A Corpus can change sources without changing the engine. A new domain can be
added without modifying the parser or runtime. A Skill can improve how an Agent
uses the domain without acquiring schema or write authority.
