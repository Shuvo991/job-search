import { z } from "zod";
import { idSchema, longText, paginationSchema, shortText } from "@/schemas/common";
import { APPLICATION_STATUSES, EVENT_TYPES } from "@/schemas/enums";

export const createApplicationSchema = z.object({
  jobId: idSchema,
  status: z.enum(APPLICATION_STATUSES).default("SAVED"),
  notes: longText(10_000).optional(),
});

export const updateApplicationSchema = z
  .object({
    status: z.enum(APPLICATION_STATUSES),
    appliedAt: z.coerce.date().nullable(),
    followUpAt: z.coerce.date().nullable(),
    nextStep: shortText(500).nullable(),
    notes: longText(10_000).nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field to update" });

export const listApplicationsQuerySchema = paginationSchema.extend({
  status: z.enum(APPLICATION_STATUSES).optional(),
});

export const createApplicationEventSchema = z.object({
  type: z.enum(EVENT_TYPES),
  note: longText(5_000).optional(),
  occurredAt: z.coerce.date().optional(),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type UpdateApplicationInput = z.infer<typeof updateApplicationSchema>;
