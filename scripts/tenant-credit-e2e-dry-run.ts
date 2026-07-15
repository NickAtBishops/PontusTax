// End-to-end dry run of the tenant-credit writeback against a REAL
// tracker workbook, without Claude: extract packets are constructed
// from the verified contents of the real Q1 2026 statements, then sent
// through the actual writeback route handler (sanitize → tenant match →
// header match → formula guard → OOXML patch → post-verify). The
// original tracker file is never touched; audit falls to the local-dev
// skip path when Firestore isn't configured.
//
// Usage:
//   npx tsx scripts/tenant-credit-e2e-dry-run.ts "<path to tracker.xlsx>"
//
// Exit code 0 = every assertion passed.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";

import { POST as writebackPost } from "@/app/api/tenant-credit/writeback/route";
import { POST as tenantsPost } from "@/app/api/tenant-credit/tenants/route";
import { computeGeneric } from "@/lib/tenant-credit/generic-methodology";
import {
  mergeLineItems,
  type MergeExtract,
} from "@/lib/tenant-credit/merge-line-items";
import { stripExcelCommentsForExcelJs } from "@/lib/tenant-credit/xlsx-sanitize";
import { trackerColumnsForQuarter } from "@/lib/tenant-credit/tracker-layout";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const QUARTER = "Q1_2026" as const;

const trackerPath = process.argv[2];
if (!trackerPath) {
  console.error("Usage: npx tsx scripts/tenant-credit-e2e-dry-run.ts <tracker.xlsx>");
  process.exit(1);
}
const trackerBytes = readFileSync(trackerPath);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function sha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

type Item = { label: string; amount: number; ref: string };

function extract(
  filename: string,
  period: string,
  entity: string,
  items: Item[],
  overrides: Partial<MergeExtract> = {},
): MergeExtract & { level: "tenant" | "corporate" } {
  return {
    source_entity: entity,
    source_period: period,
    source_file_hash: sha(filename),
    source_filename: filename,
    source_units: "dollars",
    source_units_evidence: "$ amounts with cents",
    document_type: "income_statement",
    source_scope: "entire entity",
    source_scope_type: "entity_wide",
    source_scope_identifiers: [],
    period_selection: "printed_quarter_total",
    line_items: items.map((item) => ({
      label: item.label,
      printed_amount: item.amount,
      amount: item.amount,
      source_reference: item.ref,
    })),
    level: "tenant",
    ...overrides,
  };
}

// Verified contents of the real statements (pdftotext / verifier runs,
// 2026-07-14 review).
const pinnacleExtracts = [
  extract(
    "Pinnacle Holding INC_Income Statement_Q1_2026.pdf",
    "Jan 2026 - Mar 2026",
    "Pinnacle Oil & Gas Holding INC",
    [
      { label: "Total for Sales", amount: 51_700_008.54, ref: "page 1" },
      { label: "Total for Income", amount: 59_784_204.82, ref: "page 1" },
      { label: "Net Income", amount: 5_258_230.36, ref: "page 2" },
      { label: "Depreciation Expense", amount: 821_457.93, ref: "page 2" },
      { label: "Interest Paid", amount: 1_381_082.34, ref: "page 2" },
      { label: "Rent", amount: 9_905_979.21, ref: "page 2" },
      { label: "Management Income", amount: 355_360, ref: "page 1" },
      { label: "Management Fee", amount: 355_360, ref: "page 2" },
    ],
  ),
];

const ethemaExtracts = [
  extract(
    "Evernia Q1 PL.pdf",
    "January through March 2026",
    "Evernia Health Services LLC",
    [
      { label: "Total Income", amount: 1_365_000, ref: "page 1" },
      { label: "Net Income", amount: -617_618.71, ref: "page 2" },
      { label: "Depreciation", amount: 35_025.39, ref: "page 2" },
      { label: "Discount Amorti ation", amount: 38_468.95, ref: "page 2" },
      { label: "Interest Expense", amount: 28_478.93, ref: "page 2" },
      { label: "Rent - Boca cove", amount: 94_423.47, ref: "page 1" },
      { label: "Rent - Other buildings", amount: 18_000, ref: "page 1" },
      { label: "Rent Smoothing", amount: -948.81, ref: "page 1" },
      { label: "Interco - Rent", amount: 229_227.45, ref: "page 1" },
    ],
  ),
];

// Kraf-shaped monthly packet: three entity-wide monthly statements that
// must SUM into the quarter (incl. a legitimately zero-sales February).
function krafMonth(name: string, period: string, items: Item[]) {
  return extract(name, period, "Kraf Inc", items, {
    period_selection: "single_period_column",
  });
}
const krafExtracts = [
  krafMonth("JANUARY.pdf", "Jan 2026", [
    { label: "Gross Sales", amount: 145_086.22, ref: "page 1" },
    { label: "Net Income", amount: 12_000, ref: "page 1" },
    { label: "Rent", amount: 8_300, ref: "page 1" },
  ]),
  krafMonth("FEBRUARY - ZERO SALES.pdf", "Feb 2026", [
    { label: "Gross Sales", amount: 0, ref: "page 1" },
    { label: "Net Income", amount: -9_500, ref: "page 1" },
    { label: "Rent", amount: 8_300, ref: "page 1" },
  ]),
  krafMonth("MARCH.pdf", "Mar 2026", [
    { label: "Gross Sales", amount: 165_220.43, ref: "page 1" },
    { label: "Net Income", amount: 15_800, ref: "page 1" },
    { label: "Rent", amount: 8_300, ref: "page 1" },
  ]),
];

type Packet = MergeExtract & { level: "tenant" | "corporate" };

function entryFor(
  tenantId: string,
  displayName: string,
  row: number,
  extracts: Packet[],
) {
  const merged = mergeLineItems(extracts, QUARTER);
  const computed = computeGeneric(merged.merged);
  return {
    entry: {
      tenant_id: tenantId,
      tenant_display_name: displayName,
      tracker_row: row,
      sales: computed.sales,
      ebitda: computed.ebitda,
      interest: computed.interest,
      rent: computed.rent,
      cash: computed.cash,
      cfo: computed.cfo,
      capex: computed.capex,
      extracts,
      excluded_files: [],
      normalization_applied: [],
      entity_override_reason:
        "E2E dry run: packets built from verified real statement contents.",
    },
    computed,
  };
}

async function callWriteback(payload: unknown): Promise<Response> {
  const form = new FormData();
  form.append(
    "tracker_xlsx",
    new File([new Uint8Array(trackerBytes)], "tracker.xlsx", { type: XLSX_MIME }),
  );
  form.append("payload", JSON.stringify(payload));
  return writebackPost(
    new Request("http://localhost/api/tenant-credit/writeback", {
      method: "POST",
      body: form,
    }),
  );
}

async function fetchRoster(): Promise<
  { display_name: string; row: number; tenant_id: string }[]
> {
  const form = new FormData();
  form.append(
    "tracker_xlsx",
    new File([new Uint8Array(trackerBytes)], "tracker.xlsx", { type: XLSX_MIME }),
  );
  const res = await tenantsPost(
    new Request("http://localhost/api/tenant-credit/tenants", {
      method: "POST",
      body: form,
    }),
  );
  if (res.status !== 200) {
    throw new Error(`tenants route refused the tracker: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    tenants: { display_name: string; row: number; tenant_id: string }[];
  };
  return body.tenants;
}

async function main() {
  console.log("== Tenant-credit E2E dry run against:", trackerPath);

  // ---- Roster from the REAL tenants route (exercises the sanitizer
  // and roster scan on the real workbook, and gives us the exact
  // tenant_id slugs the writeback identity check requires) ----
  const roster = await fetchRoster();
  console.log(`Roster: ${roster.length} tenants read from the tracker`);
  const byName = (name: string) => {
    const tenant = roster.find((t) => t.display_name === name);
    if (!tenant) throw new Error(`"${name}" not in roster: ${roster.map((t) => t.display_name).join(" | ")}`);
    return tenant;
  };
  const pinnacleTenant = byName("Pinnacle Oil & Gas Holdings, Inc.");
  const ethemaTenant = byName("Ethema Health Corporation");
  const krafTenant = byName("Kraf, Inc.");

  // ---- Happy path: three tenants, real rows of the real tracker ----
  const pinnacle = entryFor(pinnacleTenant.tenant_id, pinnacleTenant.display_name, pinnacleTenant.row, pinnacleExtracts);
  const ethema = entryFor(ethemaTenant.tenant_id, ethemaTenant.display_name, ethemaTenant.row, ethemaExtracts);
  const kraf = entryFor(krafTenant.tenant_id, krafTenant.display_name, krafTenant.row, krafExtracts);

  console.log("\nComputed metrics (thousands):");
  for (const [name, e] of [["Pinnacle", pinnacle], ["Ethema", ethema], ["Kraf", kraf]] as const) {
    const c = e.computed;
    console.log(
      `  ${name}: sales=${c.sales} ebitda=${c.ebitda} interest=${c.interest} rent=${c.rent}`,
    );
  }
  check("Pinnacle reproduces the hand-entered tracker values",
    pinnacle.computed.sales === 59_784 &&
    pinnacle.computed.ebitda === 7_461 &&
    pinnacle.computed.interest === 1_381 &&
    pinnacle.computed.rent === 9_906,
    JSON.stringify(pinnacle.computed.metrics.sales.formula));
  check("Kraf months sum into the quarter (incl. zero-sales February)",
    kraf.computed.sales === 310 && kraf.computed.rent === 25,
    `sales=${kraf.computed.sales} rent=${kraf.computed.rent}`);

  const res = await callWriteback({
    quarter_id: QUARTER,
    analyst_name: "E2E Dry Run",
    entries: [pinnacle.entry, ethema.entry, kraf.entry],
  });
  check("writeback responds 200", res.status === 200,
    res.status !== 200 ? JSON.stringify(await res.clone().json().catch(() => ({}))) : "");
  if (res.status !== 200) return;

  const warnings = res.headers.get("X-Worker-Warnings");
  console.log("\nWorker warnings:", warnings ?? "(none)");

  const outBytes = new Uint8Array(await res.arrayBuffer());
  const outPath = "/tmp/tenant-credit-e2e-output.xlsx";
  writeFileSync(outPath, outBytes);
  console.log("Output workbook:", outPath);

  // ---- Verify the output workbook cell by cell ----
  const target = trackerColumnsForQuarter(QUARTER);
  const colFor = (metric: string) =>
    target.cells.find((cell) => cell.metric === metric)!.col;

  const inWb = new ExcelJS.Workbook();
  await inWb.xlsx.load(stripExcelCommentsForExcelJs(
    trackerBytes.buffer.slice(trackerBytes.byteOffset, trackerBytes.byteOffset + trackerBytes.byteLength)));
  const outWb = new ExcelJS.Workbook();
  await outWb.xlsx.load(stripExcelCommentsForExcelJs(
    outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength)));
  const inSheet = inWb.getWorksheet(target.sheet_name)!;
  const outSheet = outWb.getWorksheet(target.sheet_name)!;

  for (const [name, e] of [["Pinnacle", pinnacle], ["Ethema", ethema], ["Kraf", kraf]] as const) {
    const row = e.entry.tracker_row;
    for (const metric of ["sales", "ebitda", "interest", "rent"] as const) {
      const expected = e.computed[metric];
      if (expected == null) continue;
      const actual = outSheet.getCell(row, colFor(metric)).value;
      check(`${name} row ${row} ${metric} cell = ${expected}`,
        actual === expected, `actual=${JSON.stringify(actual)}`);
    }
  }

  // Formula cells in the written rows must be untouched.
  for (const row of [8, 11, 14]) {
    let inFormulas = 0;
    let outFormulas = 0;
    let sampleIn = "";
    let sampleOut = "";
    inSheet.getRow(row).eachCell({ includeEmpty: false }, (cell) => {
      if (cell.formula) {
        inFormulas += 1;
        if (!sampleIn) sampleIn = `${cell.address}=${cell.formula}`;
      }
    });
    outSheet.getRow(row).eachCell({ includeEmpty: false }, (cell) => {
      if (cell.formula) {
        outFormulas += 1;
        if (!sampleOut) sampleOut = `${cell.address}=${cell.formula}`;
      }
    });
    check(`row ${row} formulas preserved (${inFormulas})`,
      inFormulas === outFormulas && inFormulas > 0 && sampleIn === sampleOut,
      `in=${inFormulas} out=${outFormulas} (${sampleIn} vs ${sampleOut})`);
  }

  // ---- Refusal cases (each on a fresh tracker copy) ----
  console.log("\nRefusal cases:");

  // Annual audited statement must refuse, not write.
  const valpakAnnual = extract(
    "PAK Acquisition Corp. - AFS Dec 27 2025.pdf",
    "Fiscal year ended December 27, 2025",
    "PAK Acquisition Corp.",
    [
      { label: "Total Revenue", amount: 50_000_000, ref: "page 4" },
      { label: "Net Income", amount: 2_000_000, ref: "page 4" },
    ],
  );
  const valpakTenant = byName("Valpak Direct Marketing Systems, Inc.");
  const annual = await callWriteback({
    quarter_id: QUARTER,
    analyst_name: "E2E Dry Run",
    entries: [{
      ...entryFor(valpakTenant.tenant_id, valpakTenant.display_name, valpakTenant.row, krafExtracts).entry,
      extracts: [valpakAnnual],
      sales: 50_000, ebitda: 2_000, interest: null, rent: null,
      cash: null, cfo: null, capex: null,
    }],
  });
  const annualBody = JSON.stringify(await annual.clone().json().catch(() => ({})));
  check("annual AFS refused (period unparseable/outside quarter)",
    annual.status !== 200 && /could not be converted|does not fall inside/.test(annualBody),
    `status=${annual.status} ${annualBody.slice(0, 200)}`);

  // Incomplete monthly packet must refuse.
  const incomplete = await callWriteback({
    quarter_id: QUARTER,
    analyst_name: "E2E Dry Run",
    entries: [{
      ...kraf.entry,
      extracts: [krafExtracts[0], krafExtracts[2]],
    }],
  });
  const incompleteBody = JSON.stringify(await incomplete.clone().json().catch(() => ({})));
  check("incomplete monthly packet refused (month 2 missing)",
    incomplete.status !== 200 && /month 2 is missing/.test(incompleteBody),
    `status=${incomplete.status} ${incompleteBody.slice(0, 200)}`);

  // Wrong tracker row must refuse on the tenant-identity check.
  const wrongRow = await callWriteback({
    quarter_id: QUARTER,
    analyst_name: "E2E Dry Run",
    entries: [{ ...pinnacle.entry, tracker_row: 15 }],
  });
  const wrongRowBody = JSON.stringify(await wrongRow.clone().json().catch(() => ({})));
  check("wrong tracker row refused (column A mismatch)",
    wrongRow.status !== 200,
    `status=${wrongRow.status} ${wrongRowBody.slice(0, 200)}`);

  // Client numbers that disagree with server recomputation must refuse.
  const tampered = await callWriteback({
    quarter_id: QUARTER,
    analyst_name: "E2E Dry Run",
    entries: [{ ...pinnacle.entry, sales: 99_999 }],
  });
  const tamperedBody = JSON.stringify(await tampered.clone().json().catch(() => ({})));
  check("tampered client metric refused (server recompute mismatch)",
    tampered.status !== 200 && /does not match/.test(tamperedBody),
    `status=${tampered.status} ${tamperedBody.slice(0, 200)}`);

  // Missing analyst name must refuse.
  const anonymous = await callWriteback({
    quarter_id: QUARTER,
    entries: [pinnacle.entry],
  });
  check("missing analyst name refused",
    anonymous.status !== 200, `status=${anonymous.status}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Dry run crashed:", error);
  process.exit(1);
});
