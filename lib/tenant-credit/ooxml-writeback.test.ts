import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { patchWorkbookCells } from "./ooxml-writeback";

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function fixture(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Corp Financials ");
  sheet.getCell("B2").value = 1;
  sheet.getCell("B2").note = "analyst comment";
  sheet.getCell("C2").value = { formula: "B2*2", result: 2 };
  // A shared-formula pair: D2 is the master, E2 the slave. In the
  // written OOXML the slave carries only <f t="shared" si="..."/>,
  // which is the representation the ExcelJS-level formula check used
  // to miss — the raw-XML patcher must refuse both.
  sheet.getCell("D2").value = {
    formula: "B2*3",
    result: 3,
    shareType: "shared",
    ref: "D2:E2",
  } as ExcelJS.CellFormulaValue;
  sheet.getCell("E2").value = {
    sharedFormula: "D2",
    result: 3,
  } as ExcelJS.CellSharedFormulaValue;
  const original = await workbook.xlsx.writeBuffer();
  const files = unzipSync(new Uint8Array(original));
  files["xl/externalLinks/externalLink1.xml"] = strToU8(
    "<externalLink xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"/>",
  );
  return exactBuffer(Uint8Array.from(zipSync(files)));
}

describe("patchWorkbookCells", () => {
  it("changes only the target value and workbook recalc flags", async () => {
    const input = await fixture();
    const before = unzipSync(new Uint8Array(input));
    const output = patchWorkbookCells(input, "Corp Financials ", [
      { address: "B2", value: 1234 },
    ]);
    const after = unzipSync(output);

    expect(strFromU8(after["xl/worksheets/sheet1.xml"])).toContain(
      '<c r="B2" t="n"><v>1234</v></c>',
    );
    expect(strFromU8(after["xl/workbook.xml"])).toContain('calcMode="auto"');
    expect(strFromU8(after["xl/workbook.xml"])).toContain(
      'fullCalcOnLoad="1"',
    );

    const preserved = [
      "xl/comments1.xml",
      "xl/externalLinks/externalLink1.xml",
      "xl/styles.xml",
    ];
    for (const path of preserved) {
      expect(after[path]).toEqual(before[path]);
    }
  });

  it("refuses to patch an OOXML formula cell", async () => {
    const input = await fixture();
    expect(() =>
      patchWorkbookCells(input, "Corp Financials ", [
        { address: "C2", value: 9 },
      ]),
    ).toThrow(/contains a formula/);
  });

  it("refuses to patch a shared-formula master and slave", async () => {
    const input = await fixture();
    for (const address of ["D2", "E2"]) {
      expect(() =>
        patchWorkbookCells(input, "Corp Financials ", [{ address, value: 9 }]),
      ).toThrow(/contains a formula/);
    }
  });

  it("requires the exact trailing-space sheet name", async () => {
    const input = await fixture();
    expect(() =>
      patchWorkbookCells(input, "Corp Financials", [
        { address: "B2", value: 9 },
      ]),
    ).toThrow(/missing sheet/);
  });
});
