/**
 * Country- and city-aware places for the board's Country and City filters, built from
 * config/geo-rules.json.
 *
 * Jobs store a free-text location ("Stockholm", "Göteborg") and sometimes a country ("Sverige"), so
 * a filter on "Sweden" needs something that knows Stockholm and Sverige are Sweden. This names the
 * country and city of a job for the option lists, and turns a picked country / region / city into
 * the words to look for in the database.
 */
import rulesJson from "../../config/geo-rules.json";
import { escapeRegExp, parseGeoRules, phrasePattern } from "@/lib/geo-filter";
import { normalizeForMatching } from "@/lib/language-filter";
import type { GeoRules } from "@/schemas/feed";

export const WORLDWIDE_OPTION = "Worldwide";
export const EUROPE_OPTION = "Europe";
export type RegionOption = typeof EUROPE_OPTION | typeof WORLDWIDE_OPTION;

/** Words of this length or less are matched whole ("UK", "Zug") instead of anywhere inside a word. */
const SHORT_TERM = 3;

/** Something that can look like a city but is not one. */
const NOT_A_CITY = /^(?:remote|hybrid|on site|onsite|office|europe|worldwide|anywhere|global|emea)$/;

export interface PlaceSearch {
  /** Look for these words anywhere in the location or country. */
  contains: string[];
  /** Match these exactly (short words such as "UK"). */
  equals: string[];
  /** Also include remote jobs that name no location (the worldwide boards leave it empty). */
  remoteWithoutLocation: boolean;
}

export interface ResolvedPlace {
  country?: string;
  city?: string;
}

export interface PlaceIndex {
  /** Country names, in the order of the config. */
  countries: string[];
  /** The country and city of a job (its country field first, then its location), where known. */
  resolve(location: string | null | undefined, country: string | null | undefined): ResolvedPlace;
  /** Shorthand for resolve(...).country. */
  countryOf(location: string | null | undefined, country: string | null | undefined): string | undefined;
  /** Does this job's location say "Europe", "EMEA" ...? */
  inRegion(region: RegionOption, location: string | null | undefined, remote: boolean): boolean;
  /** What to look for when the Country filter holds a country or region; undefined for any other text. */
  searchCountry(text: string): PlaceSearch | undefined;
  /** What to look for when the City filter holds `city` (a name from the option list). */
  searchCity(city: string, country?: string): PlaceSearch;
}

interface Group {
  name: string;
  names: RegExp | undefined;
  places: RegExp | undefined;
  cityPattern: RegExp | undefined;
  /** normalised spelling -> name shown in the City filter */
  cityName: Map<string, string>;
  /** shown name (normalised) -> every spelling of it */
  spellings: Map<string, string[]>;
  countryTerms: string[];
}

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(term);
    }
  }
  return result;
}

function toSearch(terms: string[], remoteWithoutLocation = false): PlaceSearch {
  // Accent-free spellings too, so "Goteborg" is found when the database has "Göteborg" and vice versa.
  const all = uniqueTerms(terms.flatMap((term) => [term, normalizeForMatching(term)]));
  return {
    contains: all.filter((term) => term.length > SHORT_TERM),
    equals: all.filter((term) => term.length <= SHORT_TERM),
    remoteWithoutLocation,
  };
}

export function createPlaceIndex(rawRules: unknown): PlaceIndex {
  const rules: GeoRules = parseGeoRules(rawRules);
  const outside = phrasePattern([...rules.outsideEurope.countries, ...rules.outsideEurope.regionsAndStates]);
  const stateCode =
    rules.outsideEurope.stateCodes.length === 0
      ? undefined
      : new RegExp(`,\\s*(?:${rules.outsideEurope.stateCodes.map(escapeRegExp).join("|")})(?![A-Za-z])`);

  const groups: Group[] = rules.europe.countryGroups.map((group) => {
    const cityName = new Map<string, string>();
    const spellings = new Map<string, string[]>();
    for (const variants of group.cityVariants) {
      const [shown] = variants;
      if (shown === undefined) continue;
      spellings.set(normalizeForMatching(shown), variants);
      for (const variant of variants) cityName.set(normalizeForMatching(variant), shown);
    }
    for (const city of group.cities) {
      const key = normalizeForMatching(city);
      if (!cityName.has(key)) {
        cityName.set(key, city);
        spellings.set(key, [city]);
      }
    }
    const allCities = [...group.cities, ...group.cityVariants.flat()];
    return {
      name: group.name,
      names: phrasePattern([group.name, ...group.aliases]),
      places: phrasePattern([group.name, ...group.aliases, ...allCities]),
      cityPattern: phrasePattern(allCities),
      cityName,
      spellings,
      countryTerms: uniqueTerms([group.name, ...group.aliases, ...allCities]),
    };
  });

  const byKey = new Map(groups.map((group) => [normalizeForMatching(group.name), group]));
  for (const configured of rules.europe.countryGroups) {
    const group = byKey.get(normalizeForMatching(configured.name));
    if (group) for (const alias of configured.aliases) byKey.set(normalizeForMatching(alias), group);
  }

  const regions = new Map(
    Object.entries(rules.europe.regionSearchTerms).map(([name, terms]) => [
      normalizeForMatching(name),
      { name, terms, pattern: phrasePattern(terms) },
    ]),
  );
  const notCities = new Set([
    ...rules.genericWords.map(normalizeForMatching),
    ...rules.worldwide.locationPhrases.map(normalizeForMatching),
    ...[...regions.values()].flatMap((region) => region.terms.map(normalizeForMatching)),
  ]);

  /** A single plain place name that none of the lists knows ("Finspång"). */
  function plainPlace(location: string): string | undefined {
    const text = location.trim();
    if (!/^\p{L}[\p{L}\p{M}.' -]{1,40}$/u.test(text)) return undefined;
    const key = normalizeForMatching(text);
    if (key === "" || NOT_A_CITY.test(key) || notCities.has(key) || byKey.has(key)) return undefined;
    return text;
  }

  function resolve(location: string | null | undefined, country: string | null | undefined): ResolvedPlace {
    const loc = location?.trim() ?? "";
    const locationText = normalizeForMatching(loc);
    const countryText = normalizeForMatching(country ?? "");

    let group = countryText === "" ? undefined : groups.find((candidate) => candidate.names?.test(countryText));
    if (group === undefined && locationText !== "") {
      const hit = groups.find((candidate) => candidate.places?.test(locationText));
      if (hit !== undefined) {
        // "Cambridge, MA" or "London, Ontario": a city followed by a non-European place is not the European one.
        const cityOnly = !hit.names?.test(locationText);
        const elsewhere = (outside?.test(locationText) ?? false) || (stateCode?.test(loc) ?? false);
        if (!(cityOnly && elsewhere)) group = hit;
      }
    }
    if (group === undefined) return {};

    const match = locationText === "" ? null : group.cityPattern?.exec(locationText);
    const city = match ? group.cityName.get(match[0]) : plainPlace(loc);
    return city === undefined ? { country: group.name } : { country: group.name, city };
  }

  return {
    countries: groups.map((group) => group.name),
    resolve,
    countryOf: (location, country) => resolve(location, country).country,

    inRegion(region, location, remote) {
      const text = normalizeForMatching(location ?? "");
      const entry = regions.get(normalizeForMatching(region));
      if (entry?.pattern !== undefined && text !== "" && entry.pattern.test(text)) return true;
      return region === WORLDWIDE_OPTION && remote && text === "";
    },

    searchCountry(text) {
      const key = normalizeForMatching(text);
      if (key === "") return undefined;
      const region = regions.get(key);
      if (region) return { contains: uniqueTerms(region.terms), equals: [], remoteWithoutLocation: region.name === WORLDWIDE_OPTION };
      const group = byKey.get(key);
      return group === undefined ? undefined : toSearch(group.countryTerms);
    },

    searchCity(city, country) {
      const key = normalizeForMatching(city);
      const chosen = country === undefined ? undefined : byKey.get(normalizeForMatching(country));
      for (const group of chosen === undefined ? groups : [chosen]) {
        const shown = group.cityName.get(key);
        const spellings = shown === undefined ? undefined : group.spellings.get(normalizeForMatching(shown));
        if (spellings !== undefined) return toSearch(spellings);
      }
      return toSearch([city]);
    },
  };
}

let defaultIndex: PlaceIndex | undefined;

export function getPlaceIndex(): PlaceIndex {
  defaultIndex ??= createPlaceIndex(rulesJson);
  return defaultIndex;
}
