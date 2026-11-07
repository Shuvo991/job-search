import { z } from "zod";
import { httpUrlSchema, longText, shortText } from "@/schemas/common";
import { WORK_MODES } from "@/schemas/enums";

const experienceEntrySchema = z.object({
  company: shortText(200),
  title: shortText(200),
  startDate: shortText(20),
  endDate: shortText(20).optional(),
  description: longText(5_000).optional(),
});

const educationEntrySchema = z.object({
  institution: shortText(200),
  degree: shortText(200).optional(),
  startDate: shortText(20).optional(),
  endDate: shortText(20).optional(),
});

export const upsertProfileSchema = z.object({
  fullName: shortText(200),
  email: z.string().trim().email().max(320).optional(),
  phone: shortText(40).optional(),
  location: shortText(200).optional(),
  headline: shortText(200).optional(),
  summary: longText(5_000).optional(),
  linkedinUrl: httpUrlSchema.optional(),
  githubUrl: httpUrlSchema.optional(),
  portfolioUrl: httpUrlSchema.optional(),
  skills: z.array(shortText(60)).max(200).default([]),
  experience: z.array(experienceEntrySchema).max(50).default([]),
  education: z.array(educationEntrySchema).max(20).default([]),
  targetRoles: z.array(shortText(100)).max(30).default([]),
  preferredWorkModes: z.array(z.enum(WORK_MODES)).max(4).default([]),
  preferredLocations: z.array(shortText(100)).max(30).default([]),
});

export type UpsertProfileInput = z.infer<typeof upsertProfileSchema>;
