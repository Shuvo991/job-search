import { describe, expect, it } from "vitest";
import { countWords, MAX_RESUME_CHARS, normalizeResumeText } from "@/lib/resume/text";

describe("normalizeResumeText", () => {
  it("unifies line endings and turns form feeds (PDF page breaks) into newlines", () => {
    expect(normalizeResumeText("a\r\nb\rc\u2028d\u2029e\ff")).toBe("a\nb\nc\nd\ne\nf");
  });

  it("removes control characters, bidi overrides and zero-width characters", () => {
    expect(normalizeResumeText("a\u0000b\u0007c\u007fd\u202Ee\u200Bf\u2066g\uFEFFh\u00ADi")).toBe("abcdefghi");
  });

  it("removes lone surrogates but keeps real emoji", () => {
    expect(normalizeResumeText("a\uD800b\uDC00c")).toBe("abc");
    expect(normalizeResumeText("ok \u{1F600}")).toBe("ok \u{1F600}");
  });

  it("normalises Unicode (NFC) and exotic spaces", () => {
    expect(normalizeResumeText("Cafe\u0301")).toBe("Caf\u00E9");
    expect(normalizeResumeText("a\u00A0b\u2003c\u3000d")).toBe("a b c d");
  });

  it("keeps wide gaps and tabs inside a line, which the column check relies on", () => {
    expect(normalizeResumeText("Skill A      Level A\tx")).toBe("Skill A      Level A\tx");
  });

  it("trims trailing spaces, collapses blank-line runs and trims the ends", () => {
    expect(normalizeResumeText("  \n\none   \n\n\n\n\ntwo\t\n\n  ")).toBe("one\n\ntwo");
  });

  it("drops the page markers pdf-parse can insert", () => {
    expect(normalizeResumeText("first page\n-- 1 of 2 --\nsecond page\n  -- 2 of 2 --  ")).toBe("first page\n\nsecond page");
    expect(normalizeResumeText("see -- 1 of 2 -- inline")).toBe("see -- 1 of 2 -- inline");
  });

  it("caps the length", () => {
    expect(normalizeResumeText("x".repeat(MAX_RESUME_CHARS * 3)).length).toBe(MAX_RESUME_CHARS);
  });

  it("is linear on a huge run of spaces (no regex backtracking)", () => {
    const started = Date.now();
    expect(normalizeResumeText(`${" ".repeat(150_000)}x`)).toBe("x");
    expect(normalizeResumeText(`x${" ".repeat(150_000)}`)).toBe("x");
    expect(normalizeResumeText(`${"\n ".repeat(40_000)}x`)).toBe("x");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("returns an empty string for nothing but whitespace", () => {
    expect(normalizeResumeText(" \n\t \u200B \r\n")).toBe("");
    expect(normalizeResumeText("")).toBe("");
  });
});

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n ")).toBe(0);
    expect(countWords("one")).toBe(1);
    expect(countWords("  one  two\nthree\tfour ")).toBe(4);
  });
});
