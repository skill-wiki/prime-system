export {
  type Severity, type CheckStatus, type Finding, type CheckOutcome, type SuiteCounts, type SuiteReport,
  finding, check, skipped, report, formatReport,
} from "./diagnostics.ts";

export { runModelConformance, type ModelConformanceOptions } from "./model-conformance.ts";

export { DEFAULT_RENDERER_SECTIONS_PATH, defaultRendererSections, loadRendererSections, type RendererSections } from "./renderer-sections.ts";

export {
  CorpusPackageSchema, canonicalJson, computeUnitDigest, computeContentDigest, loadCorpus,
  type CorpusPackage, type CorpusUnitRecord, type CorpusRelationRecord, type CorpusLoadResult, type CorpusLoadDiagnostic,
} from "./corpus.ts";

export { runCorpusConformance, type CorpusConformanceOptions, type GoldenQuery } from "./corpus-conformance.ts";

export { corpusFromV1Sources, type V1CorpusOptions, type V1CorpusResult } from "./corpus-adapter.ts";

export {
  runEngineInvariants,
  type EngineHarness, type Awaitable, type SnapshotHandle,
  type SnapshotIsolationCapability, type DeterministicPlanningCapability, type HardConstraintCapability,
  type AclCapability, type IdempotencyCapability, type ReplayCapability, type BundleIntegrityCapability,
} from "./engine-invariants.ts";

export {
  scanDomainSemantics, domainScanCheck, formatDomainScan, loadVocabulary, vocabularyFromModel, mergeVocabularies,
  type DomainScanOptions, type DomainScanReport, type DomainHit, type HitContext, type Vocabulary,
} from "./domain-scan.ts";
