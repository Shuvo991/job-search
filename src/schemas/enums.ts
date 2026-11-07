// Mirrors the enums in prisma/schema.prisma. tests/unit/schema-enums.test.ts fails if they drift.

export const ROLE_CATEGORIES = [
  "SOFTWARE_ENGINEER",
  "SOFTWARE_DEVELOPER",
  "AI_ENGINEER",
  "SOFTWARE_ARCHITECT",
  "PRODUCT_MANAGER",
  "PROJECT_MANAGER",
  "BUSINESS_ANALYST",
  "DATA_ANALYST",
  "DATA_ENGINEER",
  "PRODUCT_ANALYST",
] as const;

export const SECTORS = ["IT", "GAMING", "TECH"] as const;

export const WORK_MODES = ["REMOTE", "HYBRID", "ONSITE", "UNKNOWN"] as const;

export const SENIORITIES = [
  "INTERN",
  "JUNIOR",
  "MID",
  "SENIOR",
  "LEAD",
  "PRINCIPAL",
  "UNKNOWN",
] as const;

export const EMPLOYMENT_TYPES = [
  "FULL_TIME",
  "PART_TIME",
  "CONTRACT",
  "INTERNSHIP",
  "FREELANCE",
  "UNKNOWN",
] as const;

export const APPLICATION_STATUSES = [
  "SAVED",
  "PREPARING",
  "APPLIED",
  "SCREENING",
  "INTERVIEWING",
  "OFFER",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
  "GHOSTED",
] as const;

export const DOCUMENT_TYPES = [
  "TAILORED_RESUME",
  "COVER_LETTER",
  "COACH_FEEDBACK",
  "INTERVIEW_PREP",
] as const;

export const EVENT_TYPES = [
  "STATUS_CHANGE",
  "NOTE",
  "FOLLOW_UP",
  "INTERVIEW",
  "CONTACT",
  "ATS_ANALYZED",
  "DOCUMENT_GENERATED",
] as const;
