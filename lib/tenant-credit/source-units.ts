export type KnownSourceUnits = "dollars" | "thousands" | "millions";

export function sourceUnitFactor(units: KnownSourceUnits): number {
  if (units === "millions") return 1_000_000;
  if (units === "thousands") return 1_000;
  return 1;
}

export function amountMatchesSourceUnits(
  printedAmount: number,
  rawDollarAmount: number,
  units: KnownSourceUnits,
): boolean {
  const expected = printedAmount * sourceUnitFactor(units);
  const tolerance = Math.max(0.01, Math.abs(expected) * 1e-9);
  return Math.abs(rawDollarAmount - expected) <= tolerance;
}
