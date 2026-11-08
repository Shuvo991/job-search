/**
 * Location gate for imported job ads: the board keeps
 *
 *   1. jobs located in Europe (on-site, hybrid or unknown work mode: the place must be European), and
 *   2. remote jobs that candidates from anywhere can apply for.
 *
 * A remote job is kept when
 *   - its location says worldwide / anywhere (and the description does not limit it to one
 *     non-European country, e.g. "must be authorised to work in the United States"), or
 *   - it is tied to Europe (a European country or city, "Europe", "EMEA", or a region list that
 *     includes Europe such as "EMEA, USA, Canada"): that is a European job (switch in
 *     config/geo-rules.json: policy.remoteTiedToEurope), or
 *   - it names no place at all and its feed or description says it means worldwide.
 * A remote job restricted to the USA, India, "APAC" and so on is dropped.
 *
 * Matching ignores case and accents and respects word boundaries. "London, Ontario" is not London:
 * a city that is qualified by a non-European state, province or country does not count as European.
 * All lists live in config/geo-rules.json. Deterministic; no network, no AI.
 */
import rulesJson from "../../config/geo-rules.json";
import { normalizeForMatching } from "@/lib/language-filter";
import { stripCommentKeys } from "@/lib/strip-comments";
import { parseWith } from "@/lib/validation";
import { geoRulesSchema, type GeoRules } from "@/schemas/feed";

export type GeoRejectReason =
  /** On-site / hybrid job whose place is not in Europe. */
  | "outside_europe"
  /** Remote job that is restricted to non-European places, or whose place we do not recognise. */
  | "remote_not_worldwide"
  /** Remote job open to the world on paper, but the description limits it to one non-European country. */
  | "remote_restricted"
  /** No place given and nothing says it is worldwide. */
  | "no_location";

export type GeoAcceptBasis = "europe" | "europe_remote" | "worldwide_remote" | "unspecified_remote";

export type GeoVerdict =
  | { accepted: true; basis: GeoAcceptBasis }
  | { accepted: false; reason: GeoRejectReason; detail?: string };

export interface GeoInput {
  /** "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN" */
  workMode: string;
  location?: string | undefined;
  /** Country as the source gave it. */
  country?: string | undefined;
  /** The feed's configured default country: only used when the location itself is not recognised. */
  defaultCountry?: string | undefined;
  /** Plain-text description (used to catch "work from anywhere" and "must be based in the US"). */
  description?: string | undefined;
  /** The feed leaves the location empty on jobs open to the whole world (Remote OK). */
  worldwideWhenNoLocation?: boolean | undefined;
}

export interface GeoFilter {
  evaluate(input: GeoInput): GeoVerdict;
  readonly rules: GeoRules;
}

const MAX_DESCRIPTION_CHARS = 30_000;
const LOOKAHEAD_CHARS = 60;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One case-insensitive-by-normalisation, whole-word regex for a list of phrases (longest first). */
export function phrasePattern(phrases: string[]): RegExp | undefined {
  const normalized = [...new Set(phrases.map(normalizeForMatching).filter((phrase) => phrase !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  if (normalized.length === 0) return undefined;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${normalized.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "u");
}

const test = (pattern: RegExp | undefined, text: string): boolean => pattern?.test(text) ?? false;

interface Analysis {
  europe: boolean;
  worldwide: boolean;
  /** A recognised non-European place (and nothing European) in at least one alternative. */
  outside: boolean;
  /** Every alternative was empty once generic words ("remote", "hybrid"...) were removed. */
  blank: boolean;
}

export function parseGeoRules(raw: unknown): GeoRules {
  return parseWith(geoRulesSchema, stripCommentKeys(raw));
}

export function createGeoFilter(rawRules: unknown): GeoFilter {
  const rules = parseGeoRules(rawRules);

  const europeStrong = phrasePattern([...rules.europe.countries, ...rules.europe.regions]);
  const europeCity = phrasePattern(rules.europe.cities);
  const europeAny = phrasePattern([...rules.europe.countries, ...rules.europe.regions, ...rules.europe.cities]);
  const outsideQualifier = phrasePattern([...rules.outsideEurope.countries, ...rules.outsideEurope.regionsAndStates]);
  const outsideCity = phrasePattern(rules.outsideEurope.cities);
  const worldwideLocation = phrasePattern(rules.worldwide.locationPhrases);
  const worldwideDescription = phrasePattern(rules.worldwide.descriptionPhrases);
  const generic = phrasePattern(rules.genericWords);
  const genericGlobal = generic === undefined ? undefined : new RegExp(generic.source, "gu");
  const stateCode =
    rules.outsideEurope.stateCodes.length === 0
      ? undefined
      : new RegExp(`,\\s*(?:${rules.outsideEurope.stateCodes.join("|")})(?![A-Za-z])`);

  const restrictionParts: string[] = [];
  const leadIns = [...new Set(rules.restrictions.leadIns.map(normalizeForMatching).filter((text) => text !== ""))];
  const targets = [...new Set(rules.restrictions.targets.map(normalizeForMatching).filter((text) => text !== ""))];
  if (leadIns.length > 0 && targets.length > 0) {
    const sorted = (list: string[]) => [...list].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
    restrictionParts.push(`(?:${sorted(leadIns)})(?: the)? (?:${sorted(targets)})`);
  }
  const standalone = [...new Set(rules.restrictions.phrases.map(normalizeForMatching).filter((text) => text !== ""))];
  if (standalone.length > 0) restrictionParts.push(standalone.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"));
  const restriction =
    restrictionParts.length === 0
      ? undefined
      : new RegExp(`(?<![\\p{L}\\p{N}])(?:${restrictionParts.join("|")})(?![\\p{L}\\p{N}])`, "gu");

  /** The first limiting phrase in the description, ignoring ones followed by a European place. */
  function findRestriction(descriptionNormalized: string): string | undefined {
    if (restriction === undefined) return undefined;
    restriction.lastIndex = 0;
    for (const match of descriptionNormalized.matchAll(restriction)) {
      const after = descriptionNormalized.slice(match.index + match[0].length, match.index + match[0].length + LOOKAHEAD_CHARS);
      if (!test(europeAny, after)) return match[0];
    }
    return undefined;
  }

  function analyseAlternative(original: string): Omit<Analysis, "blank"> & { blank: boolean } {
    const normalized = normalizeForMatching(original);
    const strong = test(europeStrong, normalized);
    const city = test(europeCity, normalized);
    const qualifier = test(outsideQualifier, normalized) || (stateCode?.test(original) ?? false);
    const europe = strong || (city && !qualifier);
    const worldwide = test(worldwideLocation, normalized);
    const outside = !europe && (qualifier || test(outsideCity, normalized));
    const leftover =
      genericGlobal === undefined ? normalized : normalized.replace(genericGlobal, " ").replace(/\s+/g, " ").trim();
    return { europe, worldwide, outside, blank: leftover === "" };
  }

  function analysePlace(location: string | undefined, country: string | undefined): Analysis {
    const loc = location?.trim() ?? "";
    const ctr = country?.trim() ?? "";
    const alternatives = loc === "" ? [] : loc.split(/[;|/\n]+|\s+(?:or|&)\s+/i).map((part) => part.trim()).filter(Boolean);
    const inputs = alternatives.length > 0 ? alternatives.map((part) => (ctr === "" ? part : `${part}, ${ctr}`)) : ctr === "" ? [] : [ctr];

    const result: Analysis = { europe: false, worldwide: false, outside: false, blank: true };
    for (const input of inputs) {
      const one = analyseAlternative(input);
      result.europe ||= one.europe;
      result.worldwide ||= one.worldwide;
      result.outside ||= one.outside;
      result.blank &&= one.blank;
    }
    return result;
  }

  return {
    rules,
    evaluate(input) {
      let place = analysePlace(input.location, input.country);
      const recognised = (analysis: Analysis) => analysis.europe || analysis.worldwide || analysis.outside;
      if (!recognised(place) && input.defaultCountry !== undefined && input.defaultCountry.trim() !== "") {
        const fallback = analysePlace(undefined, input.defaultCountry);
        if (recognised(fallback)) place = fallback;
      }

      const description = input.description ?? "";
      let descriptionNormalized: string | undefined;
      const descriptionText = () => (descriptionNormalized ??= normalizeForMatching(description.slice(0, MAX_DESCRIPTION_CHARS)));
      const restrictionFor = (): string | undefined => (rules.policy.checkDescription ? findRestriction(descriptionText()) : undefined);

      if (input.workMode !== "REMOTE") {
        if (place.europe) return { accepted: true, basis: "europe" };
        if (place.blank && !place.outside && !place.worldwide) return { accepted: false, reason: "no_location" };
        return { accepted: false, reason: "outside_europe" };
      }

      // Remote.
      if (place.worldwide) {
        const limit = restrictionFor();
        return limit === undefined
          ? { accepted: true, basis: "worldwide_remote" }
          : { accepted: false, reason: "remote_restricted", detail: limit };
      }
      if (place.europe) {
        return rules.policy.remoteTiedToEurope === "keep"
          ? { accepted: true, basis: "europe_remote" }
          : { accepted: false, reason: "remote_not_worldwide", detail: "tied to Europe" };
      }
      if (place.blank && !place.outside) {
        const vouched =
          input.worldwideWhenNoLocation === true ||
          rules.policy.unspecifiedRemote === "keep" ||
          test(worldwideDescription, descriptionText());
        if (!vouched) return { accepted: false, reason: "no_location" };
        const limit = restrictionFor();
        return limit === undefined
          ? { accepted: true, basis: "unspecified_remote" }
          : { accepted: false, reason: "remote_restricted", detail: limit };
      }
      return { accepted: false, reason: "remote_not_worldwide" };
    },
  };
}

let defaultFilter: GeoFilter | undefined;

/** The location gate built from the bundled config/geo-rules.json. */
export function getGeoFilter(): GeoFilter {
  defaultFilter ??= createGeoFilter(rulesJson);
  return defaultFilter;
}

export function evaluateGeo(input: GeoInput): GeoVerdict {
  return getGeoFilter().evaluate(input);
}
