import { describe, expect, it } from "bun:test";
import {
  canonSlug,
  canonText,
  jaccard,
  kindVocabulary,
  provenanceKey,
  slugOf,
  namespaceOf,
  stripKindPrefix,
  textDigest,
  tokenSet,
  urlKey,
} from "../src/normalize.ts";

describe("id decomposition", () => {
  it("splits namespace and slug", () => {
    expect(namespaceOf("@community/check-contrast-aa")).toBe("community");
    expect(slugOf("@community/check-contrast-aa")).toBe("check-contrast-aa");
    expect(slugOf("bare-slug")).toBe("bare-slug");
  });
});

describe("stripKindPrefix", () => {
  // The vocabulary is always supplied by the caller — there is no built-in list
  // to fall back on, so every case here states the kinds it tests against. That
  // is the point: a kind is stripped because the corpus declared it, not because
  // this package happened to know the word.
  const vocab = kindVocabulary(["check", "rule", "anti-pattern", "pattern", "principle"]);

  it("strips a known kind prefix", () => {
    expect(stripKindPrefix("check-contrast-aa", vocab)).toBe("contrast-aa");
    expect(stripKindPrefix("rule-color-contrast", vocab)).toBe("color-contrast");
  });

  it("prefers the longest prefix so anti-pattern is not read as pattern", () => {
    expect(stripKindPrefix("anti-pattern-deep-branching-nav", vocab)).toBe("deep-branching-nav");
  });

  it("leaves an unprefixed slug alone", () => {
    expect(stripKindPrefix("contrast-aa", vocab)).toBe("contrast-aa");
  });

  it("strips nothing when the corpus declared no kinds", () => {
    // An empty vocabulary must be inert rather than guessing. This is what
    // replaced the hardcoded fallback list.
    expect(stripKindPrefix("check-contrast-aa", kindVocabulary([]))).toBe("check-contrast-aa");
  });

  it("honours a runtime vocabulary — the first-run bug was a hardcoded list", () => {
    // `principle` was missing from the original hardcoded list, so
    // principle-clear-user-mental-model fell through to the fuzzy tier.
    const runtimeVocab = kindVocabulary(["principle", "counter-example"]);
    expect(stripKindPrefix("principle-clear-user-mental-model", runtimeVocab)).toBe(
      "clear-user-mental-model"
    );
    expect(stripKindPrefix("counter-example-foo-bar", runtimeVocab)).toBe("foo-bar");
  });
});

describe("tokenSet", () => {
  it("is order-insensitive and de-duplicated", () => {
    expect(tokenSet("focus-ring-visible")).toEqual(tokenSet("visible-ring-focus"));
  });

  it("drops structural filler but NEVER negations", () => {
    expect(tokenSet("use-of-the-color")).toEqual(["color"]);
    // no / never / only must survive, or a rule equals its inverse
    expect(tokenSet("no-color-only-state")).toContain("no");
    expect(tokenSet("no-color-only-state")).toContain("only");
    expect(tokenSet("color-state")).not.toEqual(tokenSet("no-color-only-state"));
  });

  it("stems trailing plurals on tokens longer than 3 chars", () => {
    expect(tokenSet("design-tokens")).toEqual(tokenSet("design-token"));
    expect(tokenSet("css")).toEqual(["css"]); // ss is not stemmed
  });
});

describe("canonSlug / canonText", () => {
  it("collapses non-alphanumeric runs", () => {
    expect(canonSlug("Foo__Bar--Baz!!")).toBe("foo-bar-baz");
  });

  it("normalises unicode dashes, markdown and case in prose", () => {
    expect(canonText("Large text \u2014 `\u226518pt` **regular**")).toBe("large text 18pt regular");
  });
});

describe("textDigest", () => {
  it("is stable and normalisation-insensitive", () => {
    expect(textDigest("Never convey state using color alone.")).toBe(
      textDigest("never convey  state using COLOR alone")
    );
  });

  it("refuses to produce a matchable digest for near-empty prose", () => {
    expect(textDigest("too short")).toBe("");
    expect(textDigest(undefined)).toBe("");
    expect(textDigest(null)).toBe("");
  });
});

describe("provenanceKey", () => {
  it("keys on repo+file+section", () => {
    const a = provenanceKey("https://github.com/x/y", "src/a.ts", "Anti-patterns");
    const b = provenanceKey("https://github.com/x/y", "src/a.ts", "Anti-patterns");
    expect(a).toBe(b);
    expect(a).not.toBe(provenanceKey("https://github.com/x/y", "src/b.ts", "Anti-patterns"));
  });

  it("returns empty when there is no repo and no file", () => {
    expect(provenanceKey(null, null, "Anti-patterns")).toBe("");
  });
});

describe("urlKey", () => {
  it("ignores protocol, www, trailing slash, query and fragment", () => {
    expect(urlKey("https://www.Example.com/a/b/?q=1#f")).toBe(urlKey("http://example.com/a/b"));
  });

  it("refuses a bare host — a bare host is not identifying", () => {
    expect(urlKey("https://github.com")).toBe("");
    expect(urlKey("not a url")).toBe("");
  });
});

describe("jaccard", () => {
  it("is 1 for identical sets and 0 when either side is empty", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard([], ["a"])).toBe(0);
  });

  it("reproduces the documented 0.800 borderline case", () => {
    const a = tokenSet("clear-user-mental-model");
    const b = tokenSet(
      stripKindPrefix("principle-clear-user-mental-model", kindVocabulary(["principle"]))
    );
    expect(jaccard(a, b)).toBe(1);
  });
});
