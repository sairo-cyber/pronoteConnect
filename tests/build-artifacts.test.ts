import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("installation", () => {
  it("utilise des commandes node portables", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { name: string; scripts: Record<string, string> };
    expect(packageJson.name).toBe("pronoteconnect");
    expect(packageJson.scripts.start).toBe("node dist/src/index.js");
    expect(packageJson.scripts["mcp:stdio"]).toBe("node dist/src/stdio.js");
    await expect(access("dist/src/index.js")).resolves.toBeUndefined();
    await expect(access("dist/src/stdio.js")).resolves.toBeUndefined();
  });

  it("installe un service local sans secret intégré", async () => {
    const installer = await readFile("install.sh", "utf8");
    const tunnelInstaller = await readFile("scripts/install-tunnel-client.mjs", "utf8");
    expect(installer).toContain("pronoteconnect.service");
    expect(installer).toContain("systemctl --user enable --now");
    expect(installer).toContain("systemctl --user is-active --quiet");
    expect(installer).toContain("WorkingDirectory=${escaped_working_dir}");
    expect(installer).toContain("node node_modules/electron/install.js");
    expect(installer).toContain("PRONOTECONNECT_DATA_DIR");
    expect(tunnelInstaller).toContain("openai/tunnel-client/releases/latest");
    expect(`${installer}\n${tunnelInstaller}`).not.toMatch(/sk-[A-Za-z0-9]{16,}/u);
    expect(`${installer}\n${tunnelInstaller}`.toLowerCase()).not.toContain("tailscale funnel");
  });
});
