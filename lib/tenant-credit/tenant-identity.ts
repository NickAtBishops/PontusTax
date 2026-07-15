export function tenantIdentity(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function entityLooksLikeTenant(
  sourceEntity: string,
  tenantName: string,
): boolean {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const generic = new Set([
    "acquisition",
    "bank",
    "center",
    "company",
    "corp",
    "corporation",
    "health",
    "holding",
    "holdings",
    "inc",
    "llc",
    "ltd",
    "partners",
    "stores",
    "systems",
    "the",
  ]);
  const tokens = (value: string) =>
    normalize(value)
      .split(" ")
      .filter((token) => token.length >= 2 && !generic.has(token));
  const entityTokens = tokens(sourceEntity);
  const tenantTokens = tokens(tenantName);
  if (tenantIdentity(sourceEntity) === tenantIdentity(tenantName)) return true;
  if (entityTokens.length === 0 || tenantTokens.length === 0) return false;
  return (
    entityTokens.some((token) => tenantTokens.includes(token)) ||
    tenantTokens.some((token) => entityTokens.includes(token))
  );
}
