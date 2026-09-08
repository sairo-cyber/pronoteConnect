import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSafeLogger } from "../src/security/redaction.js";
import { MemoryTunnelSettingsStore } from "../src/storage/tunnel-settings-store.js";
import { buildTunnelInitArguments, classifyTunnelFailure, parsePluginAppId, TunnelManager } from "../src/tunnel/status.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pronoteconnect-tunnel-"));
  directories.push(value);
  return value;
}

describe("configuration du tunnel", () => {
  it("accepte une adresse de plugin et extrait son identifiant", () => {
    const id = "plugin_asdk_app_0123456789abcdef0123456789abcdef";
    expect(parsePluginAppId(`https://chatgpt.com/plugins/${id}`)).toBe(id);
    expect(() => parsePluginAppId("https://example.test")).toThrow("INVALID_PLUGIN_APP_ID");
  });

  it("ne renvoie jamais la clé d'exécution", async () => {
    const dataDir = await directory();
    const runtimeApiKey = `${["s", "k"].join("")}-0123456789abcdef0123456789abcdef`;
    const store = new MemoryTunnelSettingsStore({
      schemaVersion: 1,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeApiKey,
      updatedAt: new Date().toISOString(),
    });
    const manager = new TunnelManager({
      dataDir,
      installDir: dataDir,
      clientPath: join(dataDir, "absent"),
      settingsStore: store,
      logger: createSafeLogger(),
    });
    const status = await manager.status();
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(runtimeApiKey);
  });

  it("relie le tunnel au serveur MCP HTTP sans lancer de commande cmd", () => {
    const args = buildTunnelInitArguments(
      "C:\\PronoteConnect\\.data\\tunnel",
      "tunnel_0123456789abcdef0123456789abcdef",
      { mcpServerUrl: "http://127.0.0.1:37421/mcp" },
    );
    expect(args).toContain("sample_mcp_remote_no_auth");
    expect(args).toContain("--mcp-server-url");
    expect(args).toContain("http://127.0.0.1:37421/mcp");
    expect(args).not.toContain("--mcp-command");
    expect(args.join(" ").toLowerCase()).not.toContain("cmd.exe");
  });

  it("conserve le lancement stdio existant sur linux", () => {
    const args = buildTunnelInitArguments(
      "/tmp/pronoteconnect/tunnel",
      "tunnel_0123456789abcdef0123456789abcdef",
      { mcpCommand: "/tmp/pronoteconnect/mcp-stdio.sh" },
    );
    expect(args).toContain("sample_mcp_stdio_local");
    expect(args).toContain("--mcp-command");
    expect(args).toContain("/tmp/pronoteconnect/mcp-stdio.sh");
    expect(args).not.toContain("--mcp-server-url");
  });

  it("transforme les erreurs du tunnel en messages sûrs et utiles", () => {
    expect(classifyTunnelFailure({ code: 1, output: "request failed with status 403", timedOut: false }, "TUNNEL_PROFILE_FAILED"))
      .toBe("TUNNEL_AUTH_REJECTED");
    expect(classifyTunnelFailure({ code: 1, output: "connection timed out", timedOut: false }, "TUNNEL_PROFILE_FAILED"))
      .toBe("TUNNEL_NETWORK_ERROR");
    expect(classifyTunnelFailure({ code: 1, output: "anything", timedOut: true }, "TUNNEL_PROFILE_FAILED"))
      .toBe("TUNNEL_COMMAND_TIMEOUT");
  });
});
