import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, isLoneUrl, normalizeHttpUrl, sanitizeInline, sanitizeText } from "@/lib/sanitize";

/** A sanitized string must never contain anything tag-shaped. */
const TAG_SHAPE = /<\/?[a-z!?]/i;

describe("sanitizeText: XSS payloads are reduced to inert text", () => {
  const payloads: Array<[string, string]> = [
    ["script tag", `Hello<script>alert(1)</script>World`],
    ["script with attributes", `<script src="https://evil.example/x.js" async></script>Safe`],
    ["uppercase / mixed case", `<ScRiPt>alert(1)</sCrIpT>Safe`],
    ["img onerror", `<img src=x onerror=alert(1)>Safe`],
    ["svg onload", `<svg onload=alert(1)><circle/></svg>Safe`],
    ["iframe", `<iframe src="javascript:alert(1)"></iframe>Safe`],
    ["object / embed", `<object data="x"></object><embed src="x">Safe`],
    ["style block", `<style>body{display:none}</style>Safe`],
    ["anchor with javascript: URL", `<a href="javascript:alert(1)">click</a>`],
    ["nested tag reassembly", `<scr<script>ipt>alert(1)</scr</script>ipt>Safe`],
    ["entity-encoded script", `&lt;script&gt;alert(1)&lt;/script&gt;Safe`],
    ["numeric entity tag", `&#60;script&#62;alert(1)&#60;/script&#62;Safe`],
    ["hex entity tag", `&#x3c;img src=x onerror=alert(1)&#x3e;Safe`],
    ["html comment hiding a tag", `<!-- --><script>alert(1)</script>Safe`],
    ["unterminated script swallows the rest", `Safe<script>alert(1)`],
    ["unterminated tag", `Safe<img src=x onerror=alert(1)`],
    ["event handler on div", `<div onmouseover="alert(1)">Safe</div>`],
    ["CDATA", `<![CDATA[<script>alert(1)</script>]]>Safe`],
    ["meta refresh", `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">Safe`],
    ["math / template", `<math><mi>x</mi></math><template><script>alert(1)</script></template>Safe`],
  ];

  it.each(payloads)("%s", (_name, payload) => {
    const out = sanitizeText(payload);
    expect(out).not.toMatch(TAG_SHAPE);
    expect(out).not.toContain("alert(1)</");
    expect(out).not.toContain("onerror=alert(1)>");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("drops the content of script/style/iframe elements, keeps surrounding text", () => {
    expect(sanitizeText(`Hello<script>alert(1)</script>World`)).toBe("HelloWorld");
    expect(sanitizeText(`<style>body{}</style>Visible`)).toBe("Visible");
    expect(sanitizeText(`Before <iframe src=x></iframe> after`)).toBe("Before after");
  });

  it("keeps harmless text that merely contains angle brackets", () => {
    expect(sanitizeText("salary < 50k and > 20k")).toBe("salary < 50k and > 20k");
    expect(sanitizeText("5 < 6 && 7 > 3")).toBe("5 < 6 && 7 > 3");
    expect(sanitizeText("I <3 TypeScript")).toBe("I <3 TypeScript");
  });

  it("decodes entities only once (no double-decoding)", () => {
    expect(decodeHtmlEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
    expect(sanitizeText("Q&amp;A &amp; R&amp;D")).toBe("Q&A & R&D");
    expect(sanitizeText("&euro;50k &ndash; &euro;70k")).toBe("€50k – €70k");
  });

  it("ignores invalid numeric entities", () => {
    expect(decodeHtmlEntities("a&#0;b&#xD800;c&#9999999;d")).toBe("abcd");
  });
});

describe("sanitizeText: structure and hygiene", () => {
  it("turns block-level HTML into readable lines and bullets", () => {
    const html = `<h2>About</h2><p>We build things.</p><ul><li>TypeScript</li><li>React</li></ul>`;
    expect(sanitizeText(html)).toBe("About\n\nWe build things.\n\n- TypeScript\n- React");
  });

  it("normalises line endings and collapses blank lines", () => {
    expect(sanitizeText("a\r\n\r\n\r\n\r\nb\rc")).toBe("a\n\nb\nc");
  });

  it("removes control, zero-width and bidi override characters", () => {
    expect(sanitizeText("a\u0000b​c‮d⁦e﻿f")).toBe("abcdef");
  });

  it("removes lone surrogates but keeps real emoji", () => {
    expect(sanitizeText("ok\uD800bad")).toBe("okbad");
    expect(sanitizeText("rocket 🚀")).toBe("rocket 🚀");
  });

  it("collapses runs of spaces and trims every line", () => {
    expect(sanitizeText("  a    b  \n   c\t\td  ")).toBe("a b\nc d");
  });

  it("returns an empty string for markup-only input", () => {
    expect(sanitizeText("<script>alert(1)</script><br><div></div>")).toBe("");
  });

  it("is idempotent", () => {
    const once = sanitizeText(`<p>Hi &amp; bye</p><script>x</script><li>one</li>`);
    expect(sanitizeText(once)).toBe(once);
  });
});

describe("sanitizeInline", () => {
  it("flattens to a single line", () => {
    expect(sanitizeInline("Senior\n  Engineer <b>(Remote)</b>")).toBe("Senior Engineer (Remote)");
  });
});

describe("normalizeHttpUrl", () => {
  it("accepts http(s) URLs and strips the fragment", () => {
    expect(normalizeHttpUrl("https://example.com/jobs/1#apply")).toBe("https://example.com/jobs/1");
    expect(normalizeHttpUrl("  http://example.com/a?b=c  ")).toBe("http://example.com/a?b=c");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com/x",
    "https://user:pass@example.com/",
    "not a url",
    "",
  ])("rejects %s", (value) => {
    expect(normalizeHttpUrl(value)).toBeUndefined();
  });
});

describe("isLoneUrl", () => {
  it("detects a pasted link with no description", () => {
    expect(isLoneUrl("https://example.com/jobs/42")).toBe(true);
    expect(isLoneUrl("  https://example.com/jobs/42\n")).toBe(true);
    expect(isLoneUrl("Apply at https://example.com/jobs/42")).toBe(false);
    expect(isLoneUrl("We are hiring")).toBe(false);
  });
});
