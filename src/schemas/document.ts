import { z } from "zod";
import { idSchema } from "@/schemas/common";
import { DOCUMENT_TYPES } from "@/schemas/enums";

/** Request to generate a document with the local LLM. */
export const generateDocumentSchema = z.object({
  jobId: idSchema,
  applicationId: idSchema.optional(),
  type: z.enum(DOCUMENT_TYPES),
});

export type GenerateDocumentInput = z.infer<typeof generateDocumentSchema>;
