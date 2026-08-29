/**
 * @module test/support/security-model
 *
 * The security domain of the three-domain conformance set, kept as its own module
 * because two suites (`security-model.test.ts`, `capabilities.test.ts`) address it
 * by name and assert domain-specific facts about it.
 *
 * The loader and the field-magnitude generator live in `./domains.ts`: when the
 * second and third real domains arrived, a per-domain copy of "corpus YAML ->
 * UnitIR" would have been three copies of the one function that most needs to be
 * provably identical across domains — if loading differed per domain, "the same
 * engine ran on all three" would not follow from the suite passing.
 */

import type { CandidateGeneratorRegistry } from "../../src/index.ts";
import { DOMAINS, loadDomainPackage, type LoadedDomain } from "./domains.ts";

export type SecurityModel = LoadedDomain;

const descriptor = DOMAINS.find(domain => domain.fixtureDir === "security-model")!;

export function loadSecurityModel(): SecurityModel {
  return loadDomainPackage(descriptor.fixtureDir);
}

/** Registry wired to the names and axes the security model's own profile declares. */
export function securityRegistry(): CandidateGeneratorRegistry {
  return descriptor.registry();
}
