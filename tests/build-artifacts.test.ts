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
    const windowsInstaller = await readFile("install.ps1", "utf8");
    const windowsLauncher = await readFile("installer.cmd", "utf8");
    const windowsService = await readFile("scripts/windows-service.cjs", "utf8");
    const browserCheck = await readFile("scripts/check-browser.mjs", "utf8");
    const interfacePage = await readFile("public/index.html", "utf8");
    const interfaceScript = await readFile("public/app.js", "utf8");
    const tunnelInstaller = await readFile("scripts/install-tunnel-client.mjs", "utf8");
    expect(installer).toContain("pronoteconnect.service");
    expect(installer).toContain("systemctl --user enable pronoteconnect.service");
    expect(installer).toContain("systemctl --user restart pronoteconnect.service");
    expect(installer).toContain("systemctl --user is-active --quiet");
    expect(installer).toContain("WorkingDirectory=${escaped_working_dir}");
    expect(installer).toContain("node node_modules/electron/install.js");
    expect(installer).toContain("playwright install --with-deps chromium");
    expect(installer).toContain("node scripts/check-browser.mjs");
    expect(installer).toContain("PLAYWRIGHT_BROWSERS_PATH");
    expect(installer).toContain("PRONOTECONNECT_DATA_DIR");
    expect(windowsInstaller).toContain("node-$NodeVersion-win-$NodeArch.zip");
    expect(windowsInstaller).toContain("SHASUMS256.txt");
    expect(windowsInstaller).toContain("CreateShortcut");
    expect(windowsInstaller).toContain("scripts\\windows-service.cjs");
    expect(windowsInstaller).toContain("Register-ScheduledTask");
    expect(windowsInstaller).toContain("-LogonType Interactive -RunLevel Highest");
    expect(windowsInstaller).toContain("scripts\\check-browser.mjs");
    expect(windowsInstaller).toContain("PLAYWRIGHT_BROWSERS_PATH");
    expect(windowsLauncher).toContain("install.ps1");
    expect(windowsService).toContain("PRONOTECONNECT_TUNNEL_CLIENT");
    expect(windowsService).toContain("windowsHide: true");
    expect(windowsService).toContain("PLAYWRIGHT_BROWSERS_PATH");
    expect(browserCheck).toContain("chromium.launch({ headless: true })");
    expect(interfacePage.match(/data-setup-step=/gu)).toHaveLength(4);
    expect(interfaceScript).toContain("passer quand même");
    expect(interfaceScript).toContain("pronoteconnect-step");
    expect(tunnelInstaller).toContain("openai/tunnel-client/releases/latest");
    const installationSources = `${installer}\n${windowsInstaller}\n${windowsLauncher}\n${windowsService}\n${tunnelInstaller}`;
    expect(installationSources).not.toMatch(/sk-[A-Za-z0-9]{16,}/u);
    expect(installationSources.toLowerCase()).not.toContain("tailscale funnel");
  });
});
