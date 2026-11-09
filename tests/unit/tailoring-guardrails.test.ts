import { describe, expect, it } from "vitest";
import {
  areDatesNearEntry,
  buildSourceIndex,
  checkRewrittenText,
  findNewNumbers,
  findNewTerms,
  isFieldInSource,
  snapToSource,
} from "@/lib/tailoring/guardrails";

const CV = [
  "Jane Doe",
  "Product Manager",
  "",
  "PROFESSIONAL EXPERIENCE",
  "Senior Product Manager",
  "Acme AB, Stockholm",
  "Jan 2021 - Present",
  "• Led a team of 5 engineers to ship a payments feature used by 40% of customers",
  "• Worked with finance and legal on PSD2 compliance across 3 markets",
  "Product Owner",
  "Beta Corp",
  "2018 - 2020",
  "• Managed the backlog in Jira and ran weekly sprint reviews",
  "",
  "EDUCATION",
  "Stockholm University, MSc Computer Science, 2017 - 2019",
].join("\n");

const index = buildSourceIndex(CV);

describe("snapToSource", () => {
  it("returns the CV's own line, without the bullet glyph, for an exact quote", () => {
    const hit = snapToSource("Worked with finance and legal on PSD2 compliance across 3 markets", index);
    expect(hit?.text).toBe("Worked with finance and legal on PSD2 compliance across 3 markets");
    expect(hit?.score).toBe(1);
  });

  it("tolerates a small slip in the quote and returns the real CV wording", () => {
    const hit = snapToSource("Worked with finance and legal on PSD2 compliance across three 3 markets", index);
    expect(hit?.text).toBe("Worked with finance and legal on PSD2 compliance across 3 markets");
  });

  it("rejects a bullet the CV does not contain", () => {
    expect(snapToSource("Built a rocket engine that reached orbit", index)).toBeNull();
  });

  it("joins a bullet that the PDF text wrapped over two lines", () => {
    const wrapped = buildSourceIndex(
      "• Reduced onboarding time for new customers by redesigning\nthe welcome flow and the help centre content",
    );
    const hit = snapToSource(
      "Reduced onboarding time for new customers by redesigning the welcome flow and the help centre content",
      wrapped,
    );
    expect(hit?.text).toBe(
      "Reduced onboarding time for new customers by redesigning the welcome flow and the help centre content",
    );
  });
});

describe("findNewNumbers", () => {
  const original = "Led a team of 5 engineers to ship a payments feature used by 40% of customers";

  it("accepts numbers that were in the original, however they are spelled", () => {
    expect(findNewNumbers("Led 5 engineers; feature reached 40 percent of customers", [original])).toEqual([]);
  });

  it("flags an invented metric", () => {
    expect(findNewNumbers("Led 5 engineers and grew revenue 300%", [original])).toEqual(["300%"]);
  });

  it("does not let '10' stand in for '10k'", () => {
    expect(findNewNumbers("Served 10k users", ["Served 10 users"])).toEqual(["10k"]);
  });
});

describe("findNewTerms", () => {
  it("flags a tool that only the job posting mentions", () => {
    expect(findNewTerms("Migrated services to Kubernetes and Terraform", index)).toEqual(
      expect.arrayContaining(["Kubernetes"]),
    );
  });

  it("allows tools and words the CV already uses, and sentence-initial verbs", () => {
    expect(findNewTerms("Led sprint reviews and managed the backlog in Jira", index)).toEqual([]);
  });

  it("allows extra names only where the caller says so (the job title and company in a letter)", () => {
    const names = buildSourceIndex("Product Lead\nGlobex");
    expect(findNewTerms("I would love to join Globex", index)).toContain("Globex");
    expect(findNewTerms("I would love to join Globex", index, { alsoAllowed: names })).toEqual([]);
  });
});

describe("isFieldInSource", () => {
  it("accepts employers, titles and institutions that are written in the CV", () => {
    expect(isFieldInSource("Acme AB", index)).toBe(true);
    expect(isFieldInSource("Senior Product Manager", index)).toBe(true);
    expect(isFieldInSource("Stockholm University", index)).toBe(true);
  });

  it("treats an empty value as 'nothing claimed'", () => {
    expect(isFieldInSource("", index)).toBe(true);
  });

  it("rejects an invented employer or title", () => {
    expect(isFieldInSource("Acme Inc", index)).toBe(false);
    expect(isFieldInSource("Chief Product Officer", index)).toBe(false);
  });
});

describe("areDatesNearEntry", () => {
  it("accepts the dates written next to the entry", () => {
    expect(areDatesNearEntry("Jan 2021", index, ["Acme AB"])).toBe(true);
    expect(areDatesNearEntry("Present", index, ["Acme AB"])).toBe(true);
    expect(areDatesNearEntry("2018", index, ["Beta Corp"])).toBe(true);
  });

  it("rejects a year the CV does not give for that entry", () => {
    expect(areDatesNearEntry("2018", index, ["Acme AB"])).toBe(false);
    expect(areDatesNearEntry("2016", index, ["Beta Corp"])).toBe(false);
  });

  it("treats empty as fine", () => {
    expect(areDatesNearEntry("", index, ["Acme AB"])).toBe(true);
  });
});

describe("checkRewrittenText", () => {
  const original = "Led a team of 5 engineers to ship a payments feature used by 40% of customers";

  it("passes a rewrite that only rearranges the facts", () => {
    const flags = checkRewrittenText({
      original,
      suggested: "Shipped a payments feature used by 40% of customers, leading a team of 5 engineers",
      source: index,
      numberSources: [original],
    });
    expect(flags).toEqual([]);
  });

  it("flags an invented number and an invented tool", () => {
    const flags = checkRewrittenText({
      original,
      suggested: "Led 5 engineers on a Kubernetes migration that cut costs by 25%",
      source: index,
      numberSources: [original],
    });
    expect(flags.join(" ")).toContain("25%");
    expect(flags.join(" ")).toContain("Kubernetes");
  });

  it("flags an empty rewrite and a leftover [placeholder]", () => {
    expect(checkRewrittenText({ original, suggested: "  ", source: index, numberSources: [original] })).toHaveLength(1);
    expect(
      checkRewrittenText({ original, suggested: "Led [number] engineers", source: index, numberSources: [original] })
        .join(" "),
    ).toContain("placeholder");
  });
});

describe("findNewTerms: job title words in a letter", () => {
  const source = buildSourceIndex("Jane Doe\nSenior Product Manager at Acme AB");
  it("flags a job-posting skill phrase the CV never uses", () => {
    expect(findNewTerms("I bring Kubernetes and Product Management experience.", source)).toContain("Kubernetes");
  });
  it("accepts the skill phrase when it is part of the job title the letter names", () => {
    const jobNames = buildSourceIndex("Manager Product Management - Machine Integration\nSandvik");
    const terms = findNewTerms("I applied for the Manager Product Management role.", source, { alsoAllowed: jobNames });
    expect(terms).not.toContain("Product Management");
  });
});
