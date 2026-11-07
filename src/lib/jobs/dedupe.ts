import { createHash } from "node:crypto";

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Stable fingerprint of a posting: same company + title + location (ignoring case, punctuation and
 * accents) is the same job. Stored in the unique `dedupeHash` column.
 */
export function computeDedupeHash(job: {
  company: string;
  title: string;
  location?: string | null | undefined;
}): string {
  const key = [normalize(job.company), normalize(job.title), normalize(job.location)].join("|");
  return createHash("sha256").update(key).digest("hex");
}
