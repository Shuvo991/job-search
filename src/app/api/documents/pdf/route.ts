import { withApiHandler } from "@/lib/api-handler";
import { renderCoverLetterPdf, renderCvPdf } from "@/lib/pdf/render";
import { parseJsonBody } from "@/lib/validation";
import { pdfRequestSchema } from "@/schemas/tailoring";

// @react-pdf/renderer needs Node APIs, and every request carries a private document.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** ASCII-only file name (Content-Disposition must not carry raw user input). */
function fileNameFor(personName: string, kind: "cv" | "cover-letter"): string {
  const base =
    personName
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "document";
  return `${base}-${kind === "cv" ? "CV" : "Cover-Letter"}.pdf`;
}

/**
 * POST /api/documents/pdf   { kind: "cv", document } | { kind: "cover-letter", document }
 *
 * Renders the reviewed, edited text as a single-column, text-layer PDF with @react-pdf/renderer.
 * The body is validated field by field with Zod; the renderer only ever receives plain strings.
 */
export const POST = withApiHandler(async (req) => {
  const body = await parseJsonBody(req, pdfRequestSchema);

  const [buffer, name] =
    body.kind === "cv"
      ? ([await renderCvPdf(body.document), body.document.fullName] as const)
      : ([await renderCoverLetterPdf(body.document), body.document.senderName] as const);

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${fileNameFor(name, body.kind)}"`,
      "content-length": String(buffer.byteLength),
      "cache-control": "no-store",
    },
  });
});
