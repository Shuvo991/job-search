/**
 * Two-layer cleaning for HTML that arrives from a feed:
 *
 *  1. `sanitize-html` parses the markup properly and keeps only a short list of structural tags
 *     (paragraphs, line breaks, lists, headings) with no attributes at all. Scripts, styles,
 *     iframes, forms and everything else are removed together with their content; images (which
 *     is where tracking pixels live), links and inline styles are dropped.
 *  2. `sanitizeText` (src/lib/sanitize.ts) then flattens what is left to plain text, so what we
 *     store has no markup whatsoever and is only ever rendered as React text.
 *
 * Feeds sometimes deliver HTML entity-escaped ("&lt;p&gt;Hello&lt;/p&gt;", as Greenhouse does);
 * that is decoded once up front so it goes through the same two layers as ordinary HTML.
 */
import sanitizeHtml from "sanitize-html";
import { decodeHtmlEntities, sanitizeInline, sanitizeText } from "@/lib/sanitize";

const STRUCTURAL_TAGS = ["p", "br", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "div"];

/** Elements whose content is code or hidden data, never prose: removed together with their text. */
const NON_TEXT_TAGS = ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "svg", "template", "head"];

function looksEntityEscaped(html: string): boolean {
  return !/<[a-z!/]/i.test(html) && /&lt;\s*\/?\s*[a-z]/i.test(html);
}

export function sanitizeFeedHtml(html: string): string {
  const source = looksEntityEscaped(html) ? decodeHtmlEntities(html) : html;
  const structural = sanitizeHtml(source, {
    allowedTags: STRUCTURAL_TAGS,
    allowedAttributes: {},
    disallowedTagsMode: "discard",
    nonTextTags: NON_TEXT_TAGS,
    allowedSchemes: [],
    allowProtocolRelative: false,
  });
  return sanitizeText(structural);
}

/** Single-line fields (title, company, location) from a feed: no markup, one line. */
export function sanitizeFeedInline(value: string): string {
  return sanitizeInline(sanitizeHtml(value, { allowedTags: [], allowedAttributes: {}, nonTextTags: NON_TEXT_TAGS }));
}
