import { z } from "zod";

export const idSchema = z.string().trim().min(1).max(64);

export const idParamsSchema = z.object({ id: idSchema });

export const shortText = (max = 200) => z.string().trim().min(1).max(max);

export const longText = (max = 50_000) => z.string().trim().min(1).max(max);

/** http(s) only: rejects javascript:, data:, file: and other schemes that could lead to XSS. */
export const httpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: "Only http(s) URLs are allowed" });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Query-string boolean. z.coerce.boolean() would treat the string "false" as true. */
export const queryBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");
