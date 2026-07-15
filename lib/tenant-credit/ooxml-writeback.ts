import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export type OoxmlCellPatch = {
  address: string;
  value: number;
};

type XmlCell = Record<string, unknown> & {
  "@_r": string;
  "@_s"?: string;
  "@_t"?: string;
  f?: unknown;
  v?: unknown;
  is?: unknown;
};

type XmlRow = Record<string, unknown> & {
  "@_r": string;
  c?: XmlCell[];
};

type WorksheetDocument = {
  worksheet: Record<string, unknown> & {
    sheetData: { row: XmlRow[] };
  };
};

type WorkbookSheet = {
  "@_name": string;
  "@_r:id": string;
};

type WorkbookDocument = {
  workbook: Record<string, unknown> & {
    sheets: { sheet: WorkbookSheet[] };
    calcPr?: Record<string, unknown>;
  };
};

type Relationship = {
  "@_Id": string;
  "@_Target": string;
  "@_Type": string;
};

type RelationshipsDocument = {
  Relationships: Record<string, unknown> & {
    Relationship: Relationship[];
  };
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  isArray: (_name, path) =>
    path === "workbook.sheets.sheet" ||
    path === "Relationships.Relationship" ||
    path === "worksheet.sheetData.row" ||
    path === "worksheet.sheetData.row.c",
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: false,
  suppressEmptyNode: true,
});

function parseXml<T>(bytes: Uint8Array, path: string): T {
  try {
    return parser.parse(strFromU8(bytes), true) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${path}: ${detail}`);
  }
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(value.byteLength);
  result.set(value);
  return result;
}

function buildXml(value: unknown): Uint8Array<ArrayBuffer> {
  const xml = builder.build(value);
  const withDeclaration = xml.startsWith("<?xml")
    ? xml
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${xml}`;
  return ownedBytes(strToU8(withDeclaration));
}

function normalizePartPath(target: string): string {
  const withoutLeadingSlash = target.replace(/^\/+/, "");
  return withoutLeadingSlash.startsWith("xl/")
    ? withoutLeadingSlash
    : `xl/${withoutLeadingSlash}`;
}

function columnNumber(address: string): number {
  const match = /^([A-Z]+)\d+$/.exec(address);
  if (!match) throw new Error(`Invalid cell address ${address}.`);
  let result = 0;
  for (const char of match[1]) {
    result = result * 26 + char.charCodeAt(0) - 64;
  }
  return result;
}

function rowNumber(address: string): number {
  const match = /^[A-Z]+(\d+)$/.exec(address);
  if (!match) throw new Error(`Invalid cell address ${address}.`);
  return Number(match[1]);
}

function patchCell(sheet: WorksheetDocument, patch: OoxmlCellPatch): void {
  const targetRow = rowNumber(patch.address);
  let row = sheet.worksheet.sheetData.row.find(
    (candidate) => Number(candidate["@_r"]) === targetRow,
  );
  if (!row) {
    row = { "@_r": String(targetRow), c: [] };
    sheet.worksheet.sheetData.row.push(row);
    sheet.worksheet.sheetData.row.sort(
      (a, b) => Number(a["@_r"]) - Number(b["@_r"]),
    );
  }

  const cells = row.c ?? [];
  row.c = cells;
  let cell = cells.find((candidate) => candidate["@_r"] === patch.address);
  if (!cell) {
    const targetColumn = columnNumber(patch.address);
    const nearest = [...cells].sort(
      (a, b) =>
        Math.abs(columnNumber(a["@_r"]) - targetColumn) -
        Math.abs(columnNumber(b["@_r"]) - targetColumn),
    )[0];
    cell = {
      "@_r": patch.address,
      ...(nearest?.["@_s"] ? { "@_s": nearest["@_s"] } : {}),
    };
    cells.push(cell);
    cells.sort((a, b) => columnNumber(a["@_r"]) - columnNumber(b["@_r"]));
  }

  if (cell.f !== undefined) {
    throw new Error(`${patch.address} contains a formula in the original OOXML.`);
  }
  delete cell.is;
  delete cell.f;
  cell["@_t"] = "n";
  cell.v = String(patch.value);
}

export function patchWorkbookCells(
  input: ArrayBuffer,
  sheetName: string,
  patches: OoxmlCellPatch[],
): Uint8Array {
  const files = unzipSync(new Uint8Array(input));
  const workbookPath = "xl/workbook.xml";
  const relationshipsPath = "xl/_rels/workbook.xml.rels";
  if (!files[workbookPath] || !files[relationshipsPath]) {
    throw new Error("Workbook package is missing workbook relationships.");
  }

  const workbook = parseXml<WorkbookDocument>(files[workbookPath], workbookPath);
  const relationships = parseXml<RelationshipsDocument>(
    files[relationshipsPath],
    relationshipsPath,
  );
  const sheet = workbook.workbook.sheets.sheet.find(
    (candidate) => candidate["@_name"] === sheetName,
  );
  if (!sheet) throw new Error(`Workbook XML is missing sheet "${sheetName}".`);
  const relationship = relationships.Relationships.Relationship.find(
    (candidate) => candidate["@_Id"] === sheet["@_r:id"],
  );
  if (!relationship || !relationship["@_Type"].endsWith("/worksheet")) {
    throw new Error(`Could not resolve worksheet relationship for "${sheetName}".`);
  }

  const worksheetPath = normalizePartPath(relationship["@_Target"]);
  const worksheetBytes = files[worksheetPath];
  if (!worksheetBytes) {
    throw new Error(`Workbook package is missing ${worksheetPath}.`);
  }
  const worksheet = parseXml<WorksheetDocument>(worksheetBytes, worksheetPath);
  for (const patch of patches) patchCell(worksheet, patch);

  workbook.workbook.calcPr = {
    ...(workbook.workbook.calcPr ?? {}),
    "@_calcMode": "auto",
    "@_fullCalcOnLoad": "1",
    "@_forceFullCalc": "1",
  };
  files[worksheetPath] = buildXml(worksheet);
  files[workbookPath] = buildXml(workbook);

  return ownedBytes(zipSync(files, { level: 6 }));
}
