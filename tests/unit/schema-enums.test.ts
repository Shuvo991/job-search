import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_STATUSES,
  DOCUMENT_TYPES,
  EMPLOYMENT_TYPES,
  EVENT_TYPES,
  ROLE_CATEGORIES,
  SECTORS,
  SENIORITIES,
  WORK_MODES,
} from "@/schemas/enums";

const schema = readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");

function prismaEnum(name: string): string[] {
  const match = new RegExp(`^enum\\s+${name}\\s*\\{([\\s\\S]*?)\\}`, "m").exec(schema);
  expect(match, `enum ${name} missing from schema.prisma`).not.toBeNull();
  return (match?.[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean);
}

describe("Zod enums stay in sync with prisma/schema.prisma", () => {
  const pairs: Array<[string, readonly string[]]> = [
    ["RoleCategory", ROLE_CATEGORIES],
    ["Sector", SECTORS],
    ["WorkMode", WORK_MODES],
    ["Seniority", SENIORITIES],
    ["EmploymentType", EMPLOYMENT_TYPES],
    ["ApplicationStatus", APPLICATION_STATUSES],
    ["DocumentType", DOCUMENT_TYPES],
    ["EventType", EVENT_TYPES],
  ];

  it.each(pairs)("%s", (name, values) => {
    expect([...prismaEnum(name)].sort()).toEqual([...values].sort());
  });

  it("defines all five tables", () => {
    for (const model of ["Job", "UserProfile", "Application", "ApplicationEvent", "GeneratedDocument"]) {
      expect(schema).toMatch(new RegExp(`^model\\s+${model}\\s*\\{`, "m"));
    }
  });

  it("has no database default on Json columns (Prisma emits an invalid default for SQLite)", () => {
    expect(schema).not.toMatch(/\bJson\??\s+@default\(/);
  });
});
