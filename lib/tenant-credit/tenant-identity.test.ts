import { describe, expect, it } from "vitest";

import { entityLooksLikeTenant, tenantIdentity } from "./tenant-identity";

describe("tenantIdentity", () => {
  it("tolerates case, whitespace, and LLC punctuation", () => {
    expect(tenantIdentity("Example  Tenant, L.L.C.")).toBe(
      tenantIdentity("example tenant LLC"),
    );
  });

  it("does not discard legal suffixes", () => {
    expect(tenantIdentity("Example Tenant, LLC")).not.toBe(
      tenantIdentity("Example Tenant"),
    );
  });

  it("does not allow substring collisions", () => {
    expect(tenantIdentity("Pinnacle Oil & Gas Holdings, Inc.")).not.toBe(
      tenantIdentity("Pinnacle Services, Inc."),
    );
  });
});

describe("entityLooksLikeTenant", () => {
  it("matches real punctuation and singular/plural drift", () => {
    expect(
      entityLooksLikeTenant(
        "Pinnacle Oil & Gas Holding INC",
        "Pinnacle Oil & Gas Holdings, Inc.",
      ),
    ).toBe(true);
  });

  it("does not match two unrelated entities on a generic legal word", () => {
    expect(
      entityLooksLikeTenant(
        "Alpha Holdings LLC",
        "Pinnacle Oil & Gas Holdings, Inc.",
      ),
    ).toBe(false);
  });
});
