import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

// Keep a single client across hot reloads in development.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: getEnv().DATABASE_URL });
  return new PrismaClient({ adapter });
}

// All queries go through Prisma (parameterized). If raw SQL is ever needed, use the
// tagged-template forms ($queryRaw`...`), never string concatenation.
export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
