import { describe, expect, it } from "vitest";
import {
  createGatekeeper,
  evaluateEnglishOnly,
  normalizeForMatching,
  parseLanguageRules,
  type LanguageDetector,
} from "@/lib/language-filter";
import rulesJson from "../../config/language-rules.json";
import { ENGLISH_AD, GERMAN_AD, SPANISH_AD, SWEDISH_AD } from "../helpers/ads";

describe("Step A: language detection", () => {
  it("accepts an English ad", () => {
    expect(evaluateEnglishOnly({ title: "Senior Backend Engineer", company: "Acme", description: ENGLISH_AD })).toEqual({
      accepted: true,
      language: "eng",
    });
  });

  it("rejects a German listing", () => {
    const verdict = evaluateEnglishOnly({ title: "Softwareentwickler (m/w/d)", company: "Beispiel GmbH", description: GERMAN_AD });
    expect(verdict).toMatchObject({ accepted: false, stage: "language", reason: "not_english" });
  });

  it("rejects a Spanish listing", () => {
    const verdict = evaluateEnglishOnly({ title: "Ingeniero de software", company: "Ejemplo SL", description: SPANISH_AD });
    expect(verdict).toMatchObject({ accepted: false, stage: "language", reason: "not_english" });
  });

  it("rejects a Swedish-language listing", () => {
    const verdict = evaluateEnglishOnly({ title: "Backendutvecklare", company: "Exempel AB", description: SWEDISH_AD });
    expect(verdict).toMatchObject({ accepted: false, stage: "language", reason: "not_english" });
  });

  it("rejects text that is too short to judge", () => {
    expect(evaluateEnglishOnly({ title: "Engineer", company: "Acme", description: "Apply now" })).toMatchObject({
      accepted: false,
      stage: "language",
      reason: "too_short",
    });
  });

  it("rejects when the detector cannot tell (und)", () => {
    const gate = createGatekeeper(rulesJson, () => [["und", 1]]);
    expect(gate.evaluate({ title: "Engineer", company: "Acme", description: ENGLISH_AD })).toMatchObject({
      accepted: false,
      reason: "undetermined",
    });
  });

  describe("English mistaken for Scots", () => {
    const scotsFirst = (englishScore: number): LanguageDetector => () => [
      ["sco", 1],
      ["eng", englishScore],
      ["deu", 0.2],
    ];

    it("is accepted when English is a very close second", () => {
      const gate = createGatekeeper(rulesJson, scotsFirst(0.95));
      expect(gate.evaluate({ title: "Engineer", company: "Acme", description: ENGLISH_AD }).accepted).toBe(true);
    });

    it("is rejected when English is not close", () => {
      const gate = createGatekeeper(rulesJson, scotsFirst(0.5));
      expect(gate.evaluate({ title: "Engineer", company: "Acme", description: ENGLISH_AD })).toMatchObject({
        accepted: false,
        reason: "not_english",
        detected: "sco",
      });
    });

    it("does not rescue other languages", () => {
      const gate = createGatekeeper(rulesJson, () => [["deu", 1], ["eng", 0.99]]);
      expect(gate.evaluate({ title: "Engineer", company: "Acme", description: ENGLISH_AD }).accepted).toBe(false);
    });
  });
});

describe("Step B: required-language phrases", () => {
  const gate = createGatekeeper(rulesJson, () => [["eng", 1]]); // isolate Step B from detection

  const check = (sentence: string, company = "Acme") =>
    gate.evaluate({ title: "Backend Engineer", company, description: `${ENGLISH_AD} ${sentence}` });

  it("rejects an English ad that requires fluent Swedish", () => {
    expect(check("Fluent in Swedish and English is required.")).toMatchObject({
      accepted: false,
      stage: "keyword",
      reason: "required_language",
      phrase: "fluent in swedish",
    });
  });

  it.each([
    "Du behöver flytande svenska.",
    "Krav på svenska och engelska i tal och skrift.",
    "Svenska i tal och skrift är ett krav.",
    "We expect fliessend Deutsch.",
    "Fließend Deutsch ist Voraussetzung.",
    "FLIESSEND DEUTSCH wird erwartet",
    "You must speak Swedish with customers.",
    "Native German speaker preferred? No: native German is required.",
  ])("rejects %s", (sentence) => {
    expect(check(sentence)).toMatchObject({ accepted: false, stage: "keyword" });
  });

  it("rejects the bare word 'svenska' as configured", () => {
    expect(check("Vi är ett svenska bolag.")).toMatchObject({ accepted: false, phrase: "svenska" });
  });

  it("matches whole words only", () => {
    expect(check("We love Swedish design and Swedishness is not a requirement.").accepted).toBe(true);
  });

  it("does not reject ads that merely mention languages", () => {
    expect(check("Our working language is English. Swedish is a plus but not required.").accepted).toBe(true);
  });

  it("ignores the employer's own name, so Svenska Spel's English ads survive", () => {
    expect(check("Join Svenska Spel and help millions of players.", "Svenska Spel AB").accepted).toBe(true);
    // ...but the same word elsewhere in the ad still counts
    expect(check("Join Svenska Spel and help millions of players.", "Other Company").accepted).toBe(false);
  });

  it("reads the title too", () => {
    const verdict = gate.evaluate({ title: "Backend Engineer (flytande svenska)", company: "Acme", description: ENGLISH_AD });
    expect(verdict).toMatchObject({ accepted: false, stage: "keyword" });
  });

  it("only runs after the language check passes", () => {
    const realGate = createGatekeeper(rulesJson, () => [["deu", 1]]);
    const verdict = realGate.evaluate({ title: "Engineer", company: "Acme", description: `${ENGLISH_AD} fluent in swedish` });
    expect(verdict).toMatchObject({ stage: "language" });
  });
});

describe("rules file", () => {
  it("is valid and has phrases for Swedish and German", () => {
    const rules = parseLanguageRules(rulesJson);
    expect(rules.disqualifyingPhrases["swedish"]).toContain("flytande svenska");
    expect(rules.disqualifyingPhrases["swedish"]).toContain("svenska i tal och skrift");
    expect(rules.disqualifyingPhrases["swedish"]).toContain("krav på svenska");
    expect(rules.disqualifyingPhrases["german"]).toContain("fließend Deutsch");
  });

  it("rejects unknown keys and bad values instead of ignoring them", () => {
    expect(() => parseLanguageRules({ version: "x", disqualifyingPhrases: {}, typo: 1 })).toThrow();
    expect(() =>
      parseLanguageRules({ version: "x", detection: { minTextLength: 1 }, disqualifyingPhrases: {} }),
    ).toThrow();
  });

  it("works with no phrases at all", () => {
    const gate = createGatekeeper({ version: "x", disqualifyingPhrases: {} }, () => [["eng", 1]]);
    expect(gate.evaluate({ title: "Engineer", company: "Acme", description: ENGLISH_AD }).accepted).toBe(true);
  });

  it("normalises accents, ß and punctuation the same way for text and phrases", () => {
    expect(normalizeForMatching("Fließend  Deutsch!")).toBe("fliessend deutsch");
    expect(normalizeForMatching("français-courant")).toBe("francais courant");
  });
});
