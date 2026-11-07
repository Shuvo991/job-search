import { NextResponse } from "next/server";
import { withApiHandler } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { ServiceUnavailableError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = withApiHandler(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (cause) {
    throw new ServiceUnavailableError("Database unavailable", cause);
  }
  return NextResponse.json({ status: "ok", database: "ok" }, { headers: { "cache-control": "no-store" } });
});
