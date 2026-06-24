// Registry of all tenant configs. To add a new tenant in Phase 8:
//   1. Create lib/tenant-configs/<tenant>.ts with the recipe.
//   2. Import and add an entry to TENANT_CONFIGS below.
//   3. Add a fixture under samples/expected_<tenant>_<period>.json.
// The engine in lib/methodology.ts is unchanged. That's the point of the
// recipe pattern.

import type { TenantConfig } from "@/lib/tenant-credit/methodology";
import type { LabelAliases } from "@/lib/tenant-credit/normalization";
import { buildAliasLookup } from "@/lib/tenant-credit/normalization";
import {
  pinnacleConfig,
  pinnacleLabelAliases,
} from "@/lib/tenant-credit/tenant-configs/pinnacle";

export const TENANT_CONFIGS: Record<string, TenantConfig> = {
  [pinnacleConfig.tenant_id]: pinnacleConfig,
};

// Parallel registry of extraction-time label aliases. Lives in this
// file (next to TENANT_CONFIGS) rather than on TenantConfig itself
// because the engine doesn't use aliases and shouldn't have to know
// about them. The PDF extraction route looks up by tenant_id here.
export const TENANT_LABEL_ALIASES: Record<string, LabelAliases> = {
  [pinnacleConfig.tenant_id]: pinnacleLabelAliases,
};

// Validate alias maps at module load (cheap; runs once). buildAliasLookup
// throws on conflicts (two canonicals or two aliases that share a
// normalized form), which would silently make one canonical unreachable
// if we deferred validation to the request path.
for (const [tenantId, aliases] of Object.entries(TENANT_LABEL_ALIASES)) {
  try {
    buildAliasLookup(aliases);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `TENANT_LABEL_ALIASES for "${tenantId}" failed validation: ${reason}`,
    );
  }
}

// Helper for code paths that should fail loudly on an unknown tenant_id
// rather than silently get `undefined`. Callers that genuinely want to
// probe should index TENANT_CONFIGS directly.
//
// The hasOwnProperty check matters because TENANT_CONFIGS is a plain
// object and a key like "__proto__" or "toString" would otherwise return
// an inherited member (truthy), defeating the guard. Phase 6 will write
// tenant_id values from req.body to Firestore, so the registry sits on
// an untrusted-input boundary even though the UI uses a curated picker.
export function getTenantConfig(tenantId: string): TenantConfig {
  if (!Object.prototype.hasOwnProperty.call(TENANT_CONFIGS, tenantId)) {
    const known = Object.keys(TENANT_CONFIGS).join(", ");
    throw new Error(
      `Unknown tenant_id "${tenantId}". Known tenants: [${known}].`,
    );
  }
  return TENANT_CONFIGS[tenantId];
}

// Companion lookup for the extraction layer. Same loud-failure contract
// and same Object.prototype-leak guard.
export function getTenantLabelAliases(tenantId: string): LabelAliases {
  if (!Object.prototype.hasOwnProperty.call(TENANT_LABEL_ALIASES, tenantId)) {
    const known = Object.keys(TENANT_LABEL_ALIASES).join(", ");
    throw new Error(
      `No label aliases configured for tenant_id "${tenantId}". ` +
        `Tenants with aliases: [${known}].`,
    );
  }
  return TENANT_LABEL_ALIASES[tenantId];
}

// Map a display name from column A of the uploaded tracker (e.g.
// "Pinnacle Oil & Gas Holdings, Inc.") to one of our configured
// tenant_ids ("pinnacle"). Returns null when no recipe exists yet so
// the UI can grey out the row in the picker. Matching is intentionally
// loose: column-A spellings drift across quarters ("Pinnacle Oil & Gas
// Holdings, Inc" vs "Pinnacle Oil & Gas Holdings, Inc." vs sometimes
// just "Pinnacle Oil & Gas Holdings"), and we always want to recognize
// the same tenant. Strategy: bidirectional substring on the normalized
// names, then fall back to the first whitespace/comma-separated token
// of the config name (so "Pinnacle" alone still matches).
export function findTenantIdByDisplayName(
  displayName: string,
): string | null {
  const normalized = displayName.trim().toLowerCase();
  if (!normalized) return null;
  for (const [tenantId, config] of Object.entries(TENANT_CONFIGS)) {
    const configName = config.tenant_name.trim().toLowerCase();
    if (!configName) continue;
    if (configName.includes(normalized) || normalized.includes(configName)) {
      return tenantId;
    }
    const firstWord = configName.split(/[\s,]+/, 1)[0] ?? "";
    if (firstWord.length >= 4 && normalized.includes(firstWord)) {
      return tenantId;
    }
  }
  return null;
}
