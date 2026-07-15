import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// ExcelJS 4.4 can crash on some valid workbooks whose worksheet rels point at
// comment/VML parts in a shape it does not reconcile. The tenant-credit tool
// does not read or preserve comments, so strip those parts before parsing.
export function stripExcelCommentsForExcelJs(input: ArrayBuffer): ArrayBuffer {
  const files = unzipSync(new Uint8Array(input));
  const next: Record<string, Uint8Array> = {};

  for (const [name, bytes] of Object.entries(files)) {
    const lower = name.toLowerCase();
    if (
      lower.includes("/comments/") ||
      lower.includes("threadedcomment") ||
      lower.includes("commentsdrawing") ||
      lower.endsWith(".vml")
    ) {
      continue;
    }

    if (lower.endsWith(".rels")) {
      const xml = strFromU8(bytes);
      next[name] = strToU8(
        xml.replace(
          /<Relationship\b[^>]*(?:comments|threadedComment|vmlDrawing)[^>]*\/>/gi,
          "",
        ),
      );
      continue;
    }

    if (lower.startsWith("xl/worksheets/") && lower.endsWith(".xml")) {
      const xml = strFromU8(bytes);
      next[name] = strToU8(
        xml
          .replace(/<legacyDrawing\b[^>]*\/>/gi, "")
          .replace(/<legacyDrawingHF\b[^>]*\/>/gi, ""),
      );
      continue;
    }

    next[name] = bytes;
  }

  const out = zipSync(next);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
