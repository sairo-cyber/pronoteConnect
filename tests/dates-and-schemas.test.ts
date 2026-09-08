import { describe, expect, it } from "vitest";
import { dateRangeFromInput, parisDateToUtc, toParisIso } from "../src/domain/dates.js";
import { OpaqueIdSchema } from "../src/domain/schemas.js";
import { OpaqueIdService } from "../src/security/opaque-ids.js";

describe("normalisation Europe/Paris", () => {
  it("applique l'heure d'hiver et l'heure d'été", () => {
    expect(toParisIso(new Date("2026-01-15T12:00:00Z"))).toBe("2026-01-15T13:00:00+01:00");
    expect(toParisIso(new Date("2026-07-15T12:00:00Z"))).toBe("2026-07-15T14:00:00+02:00");
  });

  it("transforme les bornes civiles de Paris en UTC", () => {
    expect(parisDateToUtc("2026-09-07").toISOString()).toBe("2026-09-06T22:00:00.000Z");
    expect(parisDateToUtc("2026-09-07", true).toISOString()).toBe("2026-09-07T21:59:59.999Z");
  });

  it("refuse les plages inversées ou trop larges", () => {
    expect(() => dateRangeFromInput("2026-09-10", "2026-09-01")).toThrow("INVALID_DATE_RANGE");
    expect(() => dateRangeFromInput("2026-01-01", "2026-12-31")).toThrow("DATE_RANGE_TOO_LARGE");
  });
});

describe("identifiants opaques", () => {
  it("ne contient pas l'identifiant PRONOTE interne", () => {
    const internal = "sensitive-internal-id-123";
    const id = new OpaqueIdService(Buffer.alloc(32, 3)).create("hw", internal);
    expect(id).not.toContain(internal);
    expect(OpaqueIdSchema.safeParse(id).success).toBe(true);
  });

  it("refuse une URL ou un chemin à la place d'un identifiant", () => {
    expect(OpaqueIdSchema.safeParse("https://example.test/file").success).toBe(false);
    expect(OpaqueIdSchema.safeParse("../../secret").success).toBe(false);
  });
});
