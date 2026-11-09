import { describe, expect, it } from "vitest";
import { toPdfText } from "@/lib/pdf/safe-text";
import { diffWords } from "@/lib/tailoring/diff";
import { extractContact } from "@/lib/tailoring/contact";

describe("diffWords", () => {
  it("marks dropped words in the original and new words in the rewrite", () => {
    const { before, after } = diffWords("Led a team of 5 engineers", "Led 5 engineers to ship payments");
    expect(before.filter((s) => s.kind === "removed").map((s) => s.text.trim())).toEqual(["a team of"]);
    expect(after.filter((s) => s.kind === "added").map((s) => s.text.trim())).toEqual(["to ship payments"]);
    expect(before.map((s) => s.text).join("")).toBe("Led a team of 5 engineers");
    expect(after.map((s) => s.text).join("")).toBe("Led 5 engineers to ship payments");
  });

  it("ignores case and punctuation, and reports identical text as unchanged", () => {
    const { before, after } = diffWords("Managed the team, daily.", "managed the team daily");
    expect(before.every((s) => s.kind === "same")).toBe(true);
    expect(after.every((s) => s.kind === "same")).toBe(true);
  });

  it("handles empty sides", () => {
    expect(diffWords("", "new text").after).toEqual([{ kind: "added", text: "new text" }]);
    expect(diffWords("old text", "").before).toEqual([{ kind: "removed", text: "old text" }]);
  });
});

describe("toPdfText", () => {
  it("keeps Latin-1 letters, curly quotes, dashes, the bullet and the euro sign", () => {
    const text = "Åsa Öberg – “quoted” • €5";
    expect(toPdfText(text)).toBe(text);
  });

  it("replaces or drops characters Helvetica cannot draw", () => {
    expect(toPdfText("Łukasz")).toBe("Lukasz");
    expect(toPdfText("a→b")).toBe("a->b");
    expect(toPdfText("zero\u{200b}width")).toBe("zerowidth");
    expect(toPdfText("emoji \u{1F600} gone")).toBe("emoji gone");
    expect(toPdfText("line\nbreak")).toBe("line break");
  });
});

describe("extractContact", () => {
  it("reads email, phone, links and a name-like first line", () => {
    const contact = extractContact(
      "Jane Q. Doe\nStockholm | +46 70 123 45 67 | jane.doe@example.com\nlinkedin.com/in/janedoe\n\nExperience\n2019 - 2021 Acme",
    );
    expect(contact.fullName).toBe("Jane Q. Doe");
    expect(contact.email).toBe("jane.doe@example.com");
    expect(contact.phone).toBe("+46 70 123 45 67");
    expect(contact.links).toEqual(["linkedin.com/in/janedoe"]);
  });

  it("does not mistake a year range for a phone number", () => {
    expect(extractContact("Jane Doe\nAcme 2019 - 2021\n").phone).toBe("");
  });
});
