import type { QuarterId } from "./tracker-layout";

export type SourceDocumentType =
  | "income_statement"
  | "balance_sheet"
  | "cash_flow_statement"
  | "combined_financial_statements"
  | "other";

export type SourceScopeType =
  | "entity_wide"
  | "component_subset"
  | "single_component"
  | "unknown";

export type SourcePeriod = {
  startMonth: number;
  endMonth: number;
  year: number;
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function fourDigitYear(raw: string): number {
  const value = Number(raw);
  return value < 100 ? 2000 + value : value;
}

export function quarterPeriod(quarterId: QuarterId): SourcePeriod {
  const match = /^Q([1-4])_(20\d{2})$/.exec(quarterId);
  if (!match) throw new Error(`Invalid quarter id: ${quarterId}.`);
  const quarter = Number(match[1]);
  const startMonth = (quarter - 1) * 3 + 1;
  return {
    startMonth,
    endMonth: startMonth + 2,
    year: Number(match[2]),
  };
}

export function parseSourcePeriod(value: string): SourcePeriod | null {
  const text = value
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  const quarter = /\bq([1-4])\s*['-]?\s*(20\d{2}|\d{2})\b/.exec(text);
  if (quarter) {
    const q = Number(quarter[1]);
    const startMonth = (q - 1) * 3 + 1;
    return {
      startMonth,
      endMonth: startMonth + 2,
      year: fourDigitYear(quarter[2]),
    };
  }

  const monthsEnded = new RegExp(
    `\\b(three|3|six|6|nine|9|twelve|12)\\s+months?\\s+end(?:ed|ing)?` +
      `(?:\\s+(?:on|at))?\\s+(${Object.keys(MONTHS).join("|")})` +
      `(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?[,]?\\s+(20\\d{2})\\b`,
  ).exec(text);
  if (monthsEnded) {
    const durationWords: Record<string, number> = {
      three: 3,
      six: 6,
      nine: 9,
      twelve: 12,
    };
    const duration = durationWords[monthsEnded[1]] ?? Number(monthsEnded[1]);
    const endMonth = MONTHS[monthsEnded[2]];
    const startMonth = endMonth - duration + 1;
    if (startMonth < 1) return null;
    return { startMonth, endMonth, year: Number(monthsEnded[3]) };
  }

  const isoDates = Array.from(
    text.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g),
  );
  if (isoDates.length > 0) {
    const first = isoDates[0];
    const last = isoDates[isoDates.length - 1];
    if (first[1] !== last[1]) return null;
    return {
      startMonth: Number(first[2]),
      endMonth: Number(last[2]),
      year: Number(first[1]),
    };
  }

  const slashDates = Array.from(
    text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g),
  );
  if (slashDates.length > 0) {
    const years = new Set(slashDates.map((match) => Number(match[3])));
    if (years.size !== 1) return null;
    return {
      startMonth: Number(slashDates[0][1]),
      endMonth: Number(slashDates[slashDates.length - 1][1]),
      year: [...years][0],
    };
  }

  const monthPattern = Object.keys(MONTHS).join("|");
  const monthMatches = Array.from(
    text.matchAll(new RegExp(`\\b(${monthPattern})\\b`, "g")),
  );
  const years = Array.from(text.matchAll(/\b(20\d{2})\b/g));
  if (monthMatches.length === 0 || years.length === 0) return null;

  const yearValues = new Set(years.map((match) => Number(match[1])));
  if (yearValues.size !== 1) return null;
  const months = monthMatches.map((match) => MONTHS[match[1]]);
  return {
    startMonth: months[0],
    endMonth: months[months.length - 1],
    year: [...yearValues][0],
  };
}

export function periodInsideQuarter(
  period: SourcePeriod,
  quarterId: QuarterId,
): boolean {
  const quarter = quarterPeriod(quarterId);
  return (
    period.year === quarter.year &&
    period.startMonth >= quarter.startMonth &&
    period.endMonth <= quarter.endMonth &&
    period.startMonth <= period.endMonth
  );
}

export function periodsOverlap(a: SourcePeriod, b: SourcePeriod): boolean {
  return (
    a.year === b.year &&
    a.startMonth <= b.endMonth &&
    b.startMonth <= a.endMonth
  );
}

export function documentTypesOverlap(
  a: SourceDocumentType,
  b: SourceDocumentType,
): boolean {
  if (a === "other" || b === "other") return true;
  if (a === "combined_financial_statements" || b === "combined_financial_statements") {
    return true;
  }
  return a === b;
}
