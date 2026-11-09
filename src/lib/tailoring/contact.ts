/**
 * Contact details are read from the CV text with plain regular expressions, never by the model,
 * so an email address or phone number can not be hallucinated. Patterns use bounded quantifiers.
 */
import type { ContactDraft } from "@/lib/tailoring/types";

const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/;
const PHONE_CANDIDATE = /(?:\+|00)?\(?\d[\d\s().-]{6,18}\d/g;
const URL_CANDIDATE =
  /(?:https?:\/\/|www\.)[^\s<>()\[\]]{3,200}|(?:linkedin\.com|github\.com)\/[^\s<>()\[\]]{2,200}/gi;
const YEAR_RANGE = /^(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|\w+)$/;

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

export function extractEmail(text: string): string {
  return EMAIL.exec(text)?.[0] ?? "";
}

export function extractPhone(text: string): string {
  for (const match of text.matchAll(PHONE_CANDIDATE)) {
    const candidate = match[0].trim();
    const digits = digitsOf(candidate).length;
    if (digits < 8 || digits > 15) continue;
    if (YEAR_RANGE.test(candidate)) continue;
    // Looks like a phone number only if it starts like one or is grouped like one.
    const startsLikePhone = /^(?:\+|00|0)/.test(candidate) || candidate.includes("(");
    const groupedLikePhone = /^\d{3}[\s.-]\d{3}[\s.-]\d{4}$/.test(candidate);
    if (startsLikePhone || groupedLikePhone) return candidate.replace(/\s+/g, " ");
  }
  return "";
}

export function extractLinks(text: string, limit = 4): string[] {
  const links: string[] = [];
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const link = match[0].replace(/[.,;:!?]+$/, "");
    if (EMAIL.test(link)) continue;
    if (!links.some((existing) => existing.toLowerCase() === link.toLowerCase())) links.push(link);
    if (links.length >= limit) break;
  }
  return links;
}

/** First short, name-like line near the top of the CV ("Jane Q. Doe"), or "" when unsure. */
export function guessFullName(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 6);
  for (const line of lines) {
    if (line.length > 60 || /[\d@:/]/.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (words.every((word) => /^\p{Lu}[\p{L}'.’-]*$/u.test(word))) return line;
  }
  return "";
}

/**
 * "Stockholm, Sweden" from a contact line such as "Stockholm, Sweden | jane@example.com | +46 ...".
 * Only lines that look like contact lines (separators or an email) are considered.
 */
export function guessLocation(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 8);
  for (const line of lines) {
    if (!/[|·•@]/u.test(line)) continue;
    for (const segment of line.split(/\s*[|·•]\s*/u)) {
      const place = segment.trim();
      if (place.length < 3 || place.length > 60 || /[\d@:/]/.test(place)) continue;
      if (/^\p{Lu}[\p{L}.'’ -]*,\s*\p{Lu}[\p{L}.'’ -]*$/u.test(place)) return place;
    }
  }
  return "";
}

/** Everything about the candidate that can be read from the CV without a model. */
export function extractContact(text: string): ContactDraft {
  return {
    fullName: guessFullName(text),
    email: extractEmail(text),
    phone: extractPhone(text),
    location: guessLocation(text),
    links: extractLinks(text),
  };
}
