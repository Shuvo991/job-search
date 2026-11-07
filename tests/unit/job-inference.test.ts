import { describe, expect, it } from "vitest";
import {
  extractRequirements,
  inferEmploymentType,
  inferRoleCategory,
  inferSector,
  inferSeniority,
  inferWorkMode,
} from "@/lib/job-inference";

describe("inferRoleCategory", () => {
  it.each([
    ["Senior Software Engineer", "SOFTWARE_ENGINEER"],
    ["Backend Engineer (Go)", "SOFTWARE_ENGINEER"],
    ["QA Automation Engineer", "SOFTWARE_ENGINEER"],
    ["DevOps Engineer", "SOFTWARE_ENGINEER"],
    ["Full-Stack Developer", "SOFTWARE_DEVELOPER"],
    ["Gameplay Programmer", "SOFTWARE_DEVELOPER"],
    ["Unity Developer", "SOFTWARE_DEVELOPER"],
    ["Machine Learning Engineer", "AI_ENGINEER"],
    ["AI Engineer - LLM Platform", "AI_ENGINEER"],
    ["Software Engineer, AI", "AI_ENGINEER"],
    ["Prompt Engineer", "AI_ENGINEER"],
    ["Solutions Architect", "SOFTWARE_ARCHITECT"],
    ["Principal Cloud Architect", "SOFTWARE_ARCHITECT"],
    ["Technical Product Manager", "PRODUCT_MANAGER"],
    ["Associate Product Manager", "PRODUCT_MANAGER"],
    ["Head of Product", "PRODUCT_MANAGER"],
    ["AI Product Manager", "PRODUCT_MANAGER"],
    ["Technical Project Manager", "PROJECT_MANAGER"],
    ["Program Manager, Platform", "PROJECT_MANAGER"],
    ["Scrum Master", "PROJECT_MANAGER"],
    ["Business Analyst", "BUSINESS_ANALYST"],
    ["IT Systems Analyst", "BUSINESS_ANALYST"],
    ["Data Analyst", "DATA_ANALYST"],
    ["Business Intelligence Developer", "DATA_ANALYST"],
    ["Senior Data Scientist", "DATA_ANALYST"],
    ["Data Engineer", "DATA_ENGINEER"],
    ["Analytics Engineer", "DATA_ENGINEER"],
    ["Software Engineer, Data Platform", "DATA_ENGINEER"],
    ["Product Analyst", "PRODUCT_ANALYST"],
    ["Growth Analyst", "PRODUCT_ANALYST"],
  ])("%s -> %s", (title, expected) => {
    expect(inferRoleCategory(title)).toBe(expected);
  });

  it("returns undefined when the title says nothing useful", () => {
    expect(inferRoleCategory("Office Manager")).toBeUndefined();
    expect(inferRoleCategory("Chief of Staff")).toBeUndefined();
    expect(inferRoleCategory("")).toBeUndefined();
  });
});

describe("inferSeniority", () => {
  it.each([
    ["Software Engineering Intern", "INTERN"],
    ["Working Student - Data", "INTERN"],
    ["Staff Software Engineer", "PRINCIPAL"],
    ["Principal Engineer", "PRINCIPAL"],
    ["Tech Lead", "LEAD"],
    ["Head of Data", "LEAD"],
    ["Engineering Manager", "LEAD"],
    ["Senior Backend Developer", "SENIOR"],
    ["Sr. Data Analyst", "SENIOR"],
    ["Junior QA Engineer", "JUNIOR"],
    ["Associate Product Manager", "JUNIOR"],
    ["Graduate Software Engineer", "JUNIOR"],
    ["Mid-level Frontend Developer", "MID"],
    ["Software Engineer", "UNKNOWN"],
  ])("%s -> %s", (title, expected) => {
    expect(inferSeniority(title)).toBe(expected);
  });
});

describe("inferWorkMode", () => {
  it("detects the three modes", () => {
    expect(inferWorkMode("Fully remote position, work from anywhere in the EU")).toBe("REMOTE");
    expect(inferWorkMode("Hybrid: 3 days a week in our Stockholm office")).toBe("HYBRID");
    expect(inferWorkMode("This is an on-site role in Malmö")).toBe("ONSITE");
  });

  it("treats remote + on-site mentions as hybrid and negated remote as on-site", () => {
    expect(inferWorkMode("Remote-friendly, but onsite in Berlin each week")).toBe("HYBRID");
    expect(inferWorkMode("This is not a remote role")).toBe("ONSITE");
    expect(inferWorkMode("No remote work available")).toBe("ONSITE");
  });

  it("combines several inputs and returns UNKNOWN without evidence", () => {
    expect(inferWorkMode("Stockholm", "Remote (Sweden)")).toBe("REMOTE");
    expect(inferWorkMode("Stockholm", "A great job")).toBe("UNKNOWN");
    expect(inferWorkMode(undefined, undefined)).toBe("UNKNOWN");
  });
});

describe("inferEmploymentType", () => {
  it("detects the common types", () => {
    expect(inferEmploymentType("Software Engineering Intern")).toBe("INTERNSHIP");
    expect(inferEmploymentType("Data Engineer (Contract)")).toBe("CONTRACT");
    expect(inferEmploymentType("Engineer", "Employment type: Contract, 6 months")).toBe("CONTRACT");
    expect(inferEmploymentType("Engineer", "Open to freelancers")).toBe("FREELANCE");
    expect(inferEmploymentType("Engineer", "This is a part-time position")).toBe("PART_TIME");
    expect(inferEmploymentType("Engineer", "Full-time, permanent")).toBe("FULL_TIME");
  });

  it("does not mistake the word contract in prose for a contract role", () => {
    expect(inferEmploymentType("Product Manager", "You will negotiate contract terms with vendors")).toBe("UNKNOWN");
  });
});

describe("inferSector", () => {
  it("detects gaming from the title or repeated game vocabulary", () => {
    expect(inferSector("Gameplay Engineer", "Studio X")).toBe("GAMING");
    expect(inferSector("Backend Engineer", "Studio X", "We make games. Our games are played by millions of gaming fans.")).toBe(
      "GAMING",
    );
  });

  it("detects traditional IT work and defaults to tech", () => {
    expect(inferSector("Systems Administrator", "Acme", "IT support and managed services for SMEs")).toBe("IT");
    expect(inferSector("Backend Engineer", "Acme", "We build a SaaS product")).toBe("TECH");
  });
});

describe("extractRequirements", () => {
  const description = [
    "About the role",
    "We build things.",
    "",
    "Responsibilities",
    "- Ship features",
    "",
    "Requirements:",
    "- 5+ years of TypeScript",
    "• Experience with PostgreSQL",
    "2. Strong communication",
    "",
    "Nice to have",
    "- Kubernetes",
    "",
    "Benefits",
    "- Free lunch",
  ].join("\n");

  it("collects only the bullets under the requirements heading", () => {
    expect(extractRequirements(description)).toEqual([
      "5+ years of TypeScript",
      "Experience with PostgreSQL",
      "Strong communication",
    ]);
  });

  it("returns an empty list when there is no requirements section, and honours the limit", () => {
    expect(extractRequirements("Just a paragraph\n- a bullet")).toEqual([]);
    const many = `Requirements\n${Array.from({ length: 40 }, (_, i) => `- item ${i}`).join("\n")}`;
    expect(extractRequirements(many)).toHaveLength(25);
    expect(extractRequirements(many, 3)).toHaveLength(3);
  });
});
