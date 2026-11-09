import { describe, expect, it } from "vitest";
import { extractCvSkills, findSection, orderSkillsForJob, SKILLS_HEADING, SUMMARY_HEADING } from "@/lib/tailoring/cv-sections";
import { buildSourceIndex } from "@/lib/tailoring/guardrails";
import { numberCvLines } from "@/lib/tailoring/prompts";
import { guessLocation } from "@/lib/tailoring/contact";
import { isHeadingLine, reflowCvText } from "@/lib/tailoring/reflow";

/** Hard-wrap like a PDF text extractor does. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current !== "" && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

const SUMMARY =
  "Product manager with 7 years of experience owning roadmaps from customer insight through launch across fintech, ed-tech and humanitarian platforms, working directly with engineering and the CEO.";
const BULLETS = [
  "Dashboard issues drove 25% of support tickets, so led the Dashboard rebuild, the flagship project, from requirements through delivery, reaching 95% adoption and cutting tickets to 8% of volume.",
  "With 84% of signups on email and password, chose Google over other providers and shipped single sign-on, plus risk cards for real-time rule status and payout deductions.",
  "Owned product decisions for two squads, working with engineering and finance, and presented business cases and financial models in PowerPoint with Excel storyboards.",
];
const SKILLS_1 =
  "• Product Strategy: Global Product Roadmapping | Product Vision & Strategy | Product Lifecycle Ownership | Portfolio Prioritization | Go-to-Market";
const SKILLS_2 =
  "• Digital: Software & API Integration | Data Analytics | SQL | Python | Cloud (Azure, AWS) | Power BI | Compliance Workflows";

const PARAGRAPHS = [
  "JANE DOE",
  "Stockholm, Sweden | jane@example.com",
  "PROFESSIONAL SUMMARY",
  SUMMARY,
  "CORE SKILLS",
  SKILLS_1,
  SKILLS_2,
  "WORK EXPERIENCE",
  "Product Manager II | NEXT Ventures | Apr 2025 – Aug 2026",
  ...BULLETS,
  "EDUCATION",
  "MSc Information Systems, Stockholm University",
];

describe("reflowCvText", () => {
  it("joins hard-wrapped lines back into whole bullets, summary and skill lines", () => {
    const wrapped = PARAGRAPHS.flatMap((paragraph) => wrap(paragraph, 96)).join("\n");
    expect(wrapped.split("\n").length).toBeGreaterThan(PARAGRAPHS.length + 5);
    expect(reflowCvText(wrapped)).toBe(PARAGRAPHS.join("\n"));
  });

  it("leaves a CV that is not wrapped untouched", () => {
    const text = PARAGRAPHS.join("\n");
    expect(reflowCvText(text)).toBe(text);
  });

  it("keeps a new bullet marker or a heading on its own line", () => {
    const text = ["EXPERIENCE", "• Led the migration of the billing system to a new vendor over", "• Ran weekly interviews", "SKILLS", "SQL"].join("\n");
    expect(reflowCvText(text)).toBe(text);
  });

  it("joins a line that continues in lower case even without wrap detection", () => {
    expect(reflowCvText("Led a team of five\nengineers across two countries")).toBe(
      "Led a team of five engineers across two countries",
    );
  });

  it("collapses repeated blank lines", () => {
    expect(reflowCvText("A line.\n\n\n\nAnother line.")).toBe("A line.\n\nAnother line.");
  });
});

describe("isHeadingLine", () => {
  it("recognises section headings and not sentences", () => {
    expect(isHeadingLine("PROFESSIONAL SUMMARY")).toBe(true);
    expect(isHeadingLine("Work Experience")).toBe(true);
    expect(isHeadingLine("Led a team of five engineers.")).toBe(false);
    expect(isHeadingLine("Stockholm, Sweden | jane@example.com")).toBe(false);
  });
});

describe("CV sections", () => {
  const cv = reflowCvText(PARAGRAPHS.flatMap((paragraph) => wrap(paragraph, 96)).join("\n"));
  const lines = buildSourceIndex(cv).lines.map((line) => line.raw);

  it("finds the summary section by its heading", () => {
    expect(findSection(lines, SUMMARY_HEADING)?.lines).toEqual([SUMMARY]);
  });

  it("extracts the CV's own skills, keeps category labels as separate entries and keeps brackets together", () => {
    const skills = extractCvSkills(lines);
    expect(skills).toContain("Product Vision & Strategy");
    expect(skills).toContain("Cloud (Azure, AWS)");
    expect(skills).toContain("SQL");
    // Category labels stay as entries (an ATS reads them as keywords) but never glued to their items.
    expect(skills).toContain("Digital");
    expect(skills).toContain("Product Strategy");
    expect(skills.some((skill) => skill.includes(":"))).toBe(false);
    expect(findSection(lines, SKILLS_HEADING)?.lines).toHaveLength(2);
  });

  it("puts the skills a job mentions first and keeps the rest in the CV's order", () => {
    const ordered = orderSkillsForJob(["Power BI", "SQL", "Go-to-Market", "Python"], "We use Python and SQL daily.", []);
    expect(ordered).toEqual(["SQL", "Python", "Power BI", "Go-to-Market"]);
  });

  it("numbers CV lines exactly like the index the answer is resolved against", () => {
    const numbered = numberCvLines(cv).split("\n");
    expect(numbered).toHaveLength(lines.length);
    expect(numbered[0]).toBe("[1] JANE DOE");
    expect(numbered[3]).toBe(`[4] ${SUMMARY}`);
  });
});

describe("guessLocation", () => {
  it("reads the place from a contact line", () => {
    expect(guessLocation("JANE DOE\nStockholm, Sweden | jane@example.com | +46 70 123 45 67")).toBe("Stockholm, Sweden");
  });
  it("ignores ordinary sentences", () => {
    expect(guessLocation("Product Manager, Payments\nLed a team of five.")).toBe("");
  });
});
