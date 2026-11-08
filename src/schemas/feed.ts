import { z } from "zod";
import { EMPLOYMENT_TYPES, WORK_MODES } from "@/schemas/enums";
import { shortText } from "@/schemas/common";

/**
 * Validation for config/job-feeds.json and config/language-rules.json. Both files are edited by
 * hand, so every field is checked and unknown keys are rejected (a typo should fail loudly, not be
 * silently ignored). Keys starting with "_" are comments and are dropped before validation.
 */

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "use lowercase letters, digits and dashes");

/** A dotted path ("employer.name") or a list of paths where the first one with a value wins. */
const fieldPath = z.union([
  z.string().min(1).max(200),
  z.array(z.string().min(1).max(200)).min(1).max(8),
]);

export const feedFieldsSchema = z.strictObject({
  id: fieldPath.optional(),
  title: fieldPath.optional(),
  company: fieldPath.optional(),
  url: fieldPath.optional(),
  applyUrl: fieldPath.optional(),
  description: fieldPath.optional(),
  location: fieldPath.optional(),
  country: fieldPath.optional(),
  postedAt: fieldPath.optional(),
  employmentType: fieldPath.optional(),
  workMode: fieldPath.optional(),
  salaryMin: fieldPath.optional(),
  salaryMax: fieldPath.optional(),
  salaryCurrency: fieldPath.optional(),
  salaryPeriod: fieldPath.optional(),
});

const queryValue = z.union([z.string().max(200), z.number(), z.boolean()]);
const queryRecord = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/), queryValue);

const httpsUrl = z
  .string()
  .max(500)
  .refine((value) => /^https:\/\//i.test(value), { message: "feed URLs must start with https://" });

const hostPattern = z.string().regex(/^(\*\.)?[a-z0-9.-]+$/i, "a host name like example.com or *.example.com");

const instanceSchema = z.strictObject({
  id: slug,
  name: shortText(100).optional(),
  /** Employer name for feeds that do not say who is hiring (e.g. one Teamtailor board per company). */
  company: shortText(200).optional(),
  enabled: z.boolean().default(true),
  vars: z.record(z.string().regex(/^[A-Za-z0-9_]{1,30}$/), z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)).default({}),
  query: queryRecord.optional(),
  allowedHosts: z.array(hostPattern).max(10).optional(),
});

const commonFeedShape = {
  id: slug,
  name: shortText(100),
  enabled: z.boolean().default(true),
  url: httpsUrl,
  /** Replaces settings.userAgent for this feed only (a few sources reject unusual client names). */
  userAgent: z.string().min(5).max(200).optional(),
  /** True when this source leaves the location empty on jobs that anyone in the world may apply for (Remote OK). */
  worldwideWhenNoLocation: z.boolean().default(false),
  query: queryRecord.default({}),
  minIntervalMinutes: z.number().int().min(1).max(10_080).default(60),
  /** Credit line stored with every job from this feed and shown on its page. */
  attribution: shortText(300).optional(),
  /** Free-form note about the source's terms (documentation only). */
  terms: z.string().max(800).optional(),
  /** Hosts the feed may redirect to, besides the one in `url`. "*.example.com" allows subdomains. */
  allowedHosts: z.array(hostPattern).max(10).optional(),
  defaults: z
    .strictObject({
      workMode: z.enum(WORK_MODES).optional(),
      employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
      country: shortText(100).optional(),
      company: shortText(200).optional(),
    })
    .default({}),
  instances: z.array(instanceSchema).max(100).optional(),
};

const restFeedSchema = z.strictObject({
  ...commonFeedShape,
  type: z.literal("rest-json"),
  /** Path to the array of jobs in the response; empty string means the response itself is the array. */
  itemsPath: z.string().max(200).default(""),
  fields: feedFieldsSchema,
});

const rssFeedSchema = z.strictObject({
  ...commonFeedShape,
  type: z.literal("rss"),
  /** For feeds whose titles read "Role at Company": split on the LAST occurrence of this text. */
  titleCompanySeparator: z.string().min(1).max(20).optional(),
  fields: feedFieldsSchema.default({}),
});

export const feedDefinitionSchema = z.discriminatedUnion("type", [restFeedSchema, rssFeedSchema]);

/** Background sync while the app is running (src/instrumentation.ts). Per-feed cooldowns still apply. */
export const autoSyncSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** Wait this long after the server starts before the first sync, so start-up stays fast. */
  startupDelaySeconds: z.number().int().min(5).max(3600).default(30),
  intervalMinutes: z.number().int().min(15).max(1440).default(180),
});

export const feedSettingsSchema = z.strictObject({
  autoSync: autoSyncSchema.prefault({}),
  userAgent: z.string().min(5).max(200),
  requestTimeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
  maxResponseBytes: z.number().int().min(10_000).max(20_000_000).default(5_000_000),
  maxRedirects: z.number().int().min(0).max(5).default(3),
  concurrency: z.number().int().min(1).max(6).default(3),
  maxItemsPerFeed: z.number().int().min(1).max(1000).default(200),
  /** After a failed sync, wait this long before trying the same feed again. */
  failureBackoffMinutes: z.number().int().min(1).max(1440).default(5),
});

export const feedConfigSchema = z.strictObject({
  version: z.string().min(1).max(40),
  settings: feedSettingsSchema,
  feeds: z.array(feedDefinitionSchema).min(1).max(100),
});

export const languageRulesSchema = z.strictObject({
  version: z.string().min(1).max(40),
  detection: z
    .strictObject({
      /** Ads with less text than this (title + description) cannot be judged and are rejected. */
      minTextLength: z.number().int().min(10).max(1000).default(40),
      maxDetectChars: z.number().int().min(200).max(20_000).default(4000),
      /** Language codes franc often returns for English text (Scots). Accepted if English is close behind. */
      englishLookalikes: z.array(z.string().length(3)).max(5).default(["sco"]),
      lookalikeMinEnglishScore: z.number().min(0).max(1).default(0.85),
    })
    .prefault({}),
  disqualifyingPhrases: z.record(z.string().regex(/^[a-z-]{1,30}$/), z.array(z.string().min(2).max(100)).max(200)),
});

const phraseList = (max: number) => z.array(z.string().min(1).max(100)).max(max);

/** Validation for config/geo-rules.json (see src/lib/geo-filter.ts). */
export const geoRulesSchema = z.strictObject({
  version: z.string().min(1).max(40),
  policy: z
    .strictObject({
      /** keep: remote jobs restricted to Europe count as European jobs. reject: remote jobs must be worldwide. */
      remoteTiedToEurope: z.enum(["keep", "reject"]).default("keep"),
      /** What to do with a remote job that names no place (unless its feed or description says worldwide). */
      unspecifiedRemote: z.enum(["keep", "reject"]).default("reject"),
      checkDescription: z.boolean().default(true),
    })
    .prefault({}),
  europe: z.strictObject({
    countries: phraseList(400),
    regions: phraseList(100),
    cities: phraseList(1000),
    /** For the board's Location filter: a country with its other names and cities. */
    countryGroups: z
      .array(
        z.strictObject({
          name: z.string().min(2).max(60),
          aliases: phraseList(20).default([]),
          cities: phraseList(100).default([]),
          /** Spellings of the same city. The first one is the name shown in the City filter. */
          cityVariants: z.array(phraseList(6)).max(100).default([]),
        }),
      )
      .max(100)
      .default([]),
    /** Filter entries that stand for a region ("Europe", "Worldwide") and the location words they match. */
    regionSearchTerms: z.record(z.string().min(2).max(40), phraseList(20)).default({}),
  }),
  outsideEurope: z.strictObject({
    countries: phraseList(400),
    regionsAndStates: phraseList(400),
    cities: phraseList(1000),
    /** Upper-case state / province codes written after a comma ("Austin, TX"). Matched case-sensitively. */
    stateCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).max(100).default([]),
  }),
  worldwide: z.strictObject({
    locationPhrases: phraseList(100),
    descriptionPhrases: phraseList(100),
  }),
  genericWords: phraseList(200),
  restrictions: z.strictObject({
    leadIns: phraseList(200),
    targets: phraseList(200),
    phrases: phraseList(200),
  }),
});

export type GeoRules = z.output<typeof geoRulesSchema>;
export type FeedDefinition = z.output<typeof feedDefinitionSchema>;
export type AutoSyncSettings = z.output<typeof autoSyncSchema>;
export type FeedSettings = z.output<typeof feedSettingsSchema>;
export type FeedConfig = z.output<typeof feedConfigSchema>;
export type FeedFields = z.output<typeof feedFieldsSchema>;
export type LanguageRules = z.output<typeof languageRulesSchema>;

/** POST /api/jobs/sync body: omit feedIds to sync every enabled feed. */
export const syncRequestSchema = z.strictObject({
  feedIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9:-]{0,80}$/)).max(100).optional(),
});

export type SyncRequest = z.output<typeof syncRequestSchema>;
