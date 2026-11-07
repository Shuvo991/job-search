import type { EMPLOYMENT_TYPES, ROLE_CATEGORIES, SECTORS, SENIORITIES, WORK_MODES } from "@/schemas/enums";

type Label<T extends readonly string[]> = Record<T[number], string>;

export const ROLE_LABELS: Label<typeof ROLE_CATEGORIES> = {
  SOFTWARE_ENGINEER: "Software engineer",
  SOFTWARE_DEVELOPER: "Software developer",
  AI_ENGINEER: "AI engineer",
  SOFTWARE_ARCHITECT: "Software architect",
  PRODUCT_MANAGER: "Product manager",
  PROJECT_MANAGER: "Project manager",
  BUSINESS_ANALYST: "Business analyst",
  DATA_ANALYST: "Data analyst",
  DATA_ENGINEER: "Data engineer",
  PRODUCT_ANALYST: "Product analyst",
};

export const SECTOR_LABELS: Label<typeof SECTORS> = {
  IT: "IT",
  GAMING: "Gaming",
  TECH: "Tech",
};

export const WORK_MODE_LABELS: Label<typeof WORK_MODES> = {
  REMOTE: "Remote",
  HYBRID: "Hybrid",
  ONSITE: "On-site",
  UNKNOWN: "Work mode not stated",
};

export const SENIORITY_LABELS: Label<typeof SENIORITIES> = {
  INTERN: "Intern",
  JUNIOR: "Junior",
  MID: "Mid-level",
  SENIOR: "Senior",
  LEAD: "Lead",
  PRINCIPAL: "Principal / Staff",
  UNKNOWN: "Level not stated",
};

export const EMPLOYMENT_TYPE_LABELS: Label<typeof EMPLOYMENT_TYPES> = {
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  CONTRACT: "Contract",
  INTERNSHIP: "Internship",
  FREELANCE: "Freelance",
  UNKNOWN: "Type not stated",
};
