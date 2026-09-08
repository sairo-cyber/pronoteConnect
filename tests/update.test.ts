import { describe, expect, it } from "vitest";
import { checkForUpdate, newerVersion } from "../src/update/checker.js";

describe("mises à jour", () => {
  it("compare uniquement des versions stables valides", () => {
    expect(newerVersion("v0.4.0", "0.3.0")).toBe(true);
    expect(newerVersion("0.3.0", "0.3.0")).toBe(false);
    expect(newerVersion("0.2.9", "0.3.0")).toBe(false);
    expect(newerVersion("latest", "0.3.0")).toBe(false);
  });

  it("accepte seulement une publication du dépôt officiel", async () => {
    const acceptedFetcher = (async () => new Response(JSON.stringify({
      tag_name: "v0.4.0",
      html_url: "https://github.com/sairo-cyber/pronoteConnect/releases/tag/v0.4.0",
    }), { status: 200 })) as typeof fetch;
    const accepted = await checkForUpdate(acceptedFetcher);
    expect(accepted.available).toBe(true);
    expect(accepted.latestVersion).toBe("0.4.0");

    const refusedFetcher = (async () => new Response(JSON.stringify({
      tag_name: "v99.0.0",
      html_url: "https://example.com/fausse-mise-a-jour",
    }), { status: 200 })) as typeof fetch;
    const refused = await checkForUpdate(refusedFetcher);
    expect(refused.available).toBe(false);
    expect(refused.releaseUrl).toBeUndefined();
  });
});
