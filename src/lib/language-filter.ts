/**
 * English-only gatekeeper for imported job ads.
 *
 *  Step A, language detection: `franc-min` looks at the title plus the (already stripped)
 *    description. Anything that does not come out as English ("eng") is rejected, as is text too
 *    short to judge. franc sometimes calls technical English "sco" (Scots); those are accepted
 *    only if English is a very close second (configurable in config/language-rules.json).
 *  Step B, negative phrases: an English-looking ad is still rejected if it contains a phrase from
 *    config/language-rules.json such as "flytande svenska" or "fließend Deutsch": ads written in
 *    English that nevertheless require another language.
 *
 * Matching ignores case, accents and punctuation and respects word boundaries. The employer's own
 * name is removed first, so a company called "Svenska Spel" does not trigger the bare "svenska".
 */
import { francAll } from "franc-min";
import rulesJson from "../../config/language-rules.json";
import { stripCommentKeys } from "@/lib/strip-comments";
import { parseWith } from "@/lib/validation";
import { languageRulesSchema, type LanguageRules } from "@/schemas/feed";

export type GatekeeperVerdict =
  | { accepted: true; language: string }
  | { accepted: false; stage: "language"; reason: "too_short" | "undetermined" | "not_english"; detected: string }
  | { accepted: false; stage: "keyword"; reason: "required_language"; phrase: string };

export interface GatekeeperInput {
  title: string;
  company?: string | undefined;
  /** Plain text (already stripped of markup). */
  description: string;
}

/** [language code, score 0..1] sorted best first; the shape franc's `francAll` returns. */
export type LanguageGuess = Array<[string, number]>;
export type LanguageDetector = (text: string, minLength: number) => LanguageGuess;

const defaultDetector: LanguageDetector = (text, minLength) => francAll(text, { minLength });

/** Lower-case, strip accents, treat ß as ss, and turn every run of non-letters into one space. */
export function normalizeForMatching(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LEGAL_SUFFIX =
  /\s+(?:ab|aktiebolag|publ|gmbh|ag|ltd|limited|inc|llc|plc|oy|oyj|as|asa|bv|nv|sa|sl|srl|group|holding|holdings)$/;

/** The employer's name as it is likely to appear in the ad: with and without its legal suffix. */
function employerForms(company: string): string[] {
  const full = normalizeForMatching(company);
  const short = full.replace(LEGAL_SUFFIX, "");
  return [...new Set([full, short])].filter((form) => form.length >= 3).sort((a, b) => b.length - a.length);
}

export interface Gatekeeper {
  evaluate(input: GatekeeperInput): GatekeeperVerdict;
  readonly rules: LanguageRules;
}

export function parseLanguageRules(raw: unknown): LanguageRules {
  return parseWith(languageRulesSchema, stripCommentKeys(raw));
}

export function createGatekeeper(rawRules: unknown, detector: LanguageDetector = defaultDetector): Gatekeeper {
  const rules = parseLanguageRules(rawRules);
  const { minTextLength, maxDetectChars, englishLookalikes, lookalikeMinEnglishScore } = rules.detection;

  // One alternation, longest phrase first so "fluent in swedish" wins over a shorter overlap.
  const phrases = [
    ...new Set(
      Object.values(rules.disqualifyingPhrases)
        .flat()
        .map(normalizeForMatching)
        .filter((phrase) => phrase !== ""),
    ),
  ].sort((a, b) => b.length - a.length);
  const phrasePattern =
    phrases.length === 0
      ? undefined
      : new RegExp(`(?<![\\p{L}\\p{N}])(?:${phrases.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "u");

  function stepA(text: string): GatekeeperVerdict | undefined {
    if (text.replace(/\s+/g, " ").trim().length < minTextLength) {
      return { accepted: false, stage: "language", reason: "too_short", detected: "und" };
    }
    const guess = detector(text.slice(0, maxDetectChars), Math.min(minTextLength, 10));
    const [top] = guess;
    if (top === undefined || top[0] === "und") {
      return { accepted: false, stage: "language", reason: "undetermined", detected: "und" };
    }
    if (top[0] === "eng") return undefined;
    if (englishLookalikes.includes(top[0])) {
      const english = guess.find(([code]) => code === "eng");
      if (english !== undefined && english[1] >= lookalikeMinEnglishScore) return undefined;
    }
    return { accepted: false, stage: "language", reason: "not_english", detected: top[0] };
  }

  function stepB(input: GatekeeperInput, text: string): GatekeeperVerdict | undefined {
    if (phrasePattern === undefined) return undefined;
    let haystack = normalizeForMatching(text);
    for (const employer of employerForms(input.company ?? "")) {
      haystack = haystack.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(employer)}(?![\\p{L}\\p{N}])`, "gu"),
        " ",
      );
    }
    const match = phrasePattern.exec(haystack);
    return match === null ? undefined : { accepted: false, stage: "keyword", reason: "required_language", phrase: match[0] };
  }

  return {
    rules,
    evaluate(input) {
      const text = `${input.title}\n${input.description}`;
      return stepA(text) ?? stepB(input, text) ?? { accepted: true, language: "eng" };
    },
  };
}

let defaultGatekeeper: Gatekeeper | undefined;

/** The gatekeeper built from the bundled config/language-rules.json. */
export function getGatekeeper(): Gatekeeper {
  defaultGatekeeper ??= createGatekeeper(rulesJson);
  return defaultGatekeeper;
}

export function evaluateEnglishOnly(input: GatekeeperInput): GatekeeperVerdict {
  return getGatekeeper().evaluate(input);
}
