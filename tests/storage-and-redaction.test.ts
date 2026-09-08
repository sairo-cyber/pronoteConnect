import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EncryptedFileCredentialStore, MemoryCredentialStore } from "../src/storage/credential-store.js";
import { EncryptedFileTunnelSettingsStore } from "../src/storage/tunnel-settings-store.js";
import { redact, redactText } from "../src/security/redaction.js";
import type { StoredCredential } from "../src/domain/types.js";

function credential(secret = randomBytes(28).toString("base64url")): StoredCredential {
  return {
    schemaVersion: 1,
    pronoteUrl: "https://school.example/pronote",
    username: `student-${randomUUID()}`,
    accountKind: "STUDENT",
    deviceUUID: randomUUID(),
    token: secret,
    lastConnectedAt: new Date().toISOString(),
  };
}

describe("stockage des identifiants", () => {
  it("effectue une rotation atomique en mémoire", async () => {
    const first = credential();
    const second = credential();
    const store = new MemoryCredentialStore(first);
    await store.set(second);
    expect((await store.get())?.token).toBe(second.token);
    expect((await store.get())?.token).not.toBe(first.token);
    await store.delete();
    expect(await store.get()).toBeNull();
  });

  it("chiffre le fallback local avec des permissions restrictives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronote-store-test-"));
    const value = credential();
    const store = new EncryptedFileCredentialStore(directory);
    await store.set(value);
    const encrypted = await readFile(join(directory, "credentials.enc"), "utf8");
    expect(encrypted).not.toContain(value.token);
    if (process.platform !== "win32") {
      expect((await stat(join(directory, "credentials.enc"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "fallback-master.key"))).mode & 0o777).toBe(0o600);
    }
    expect(await store.get()).toEqual(value);
    await store.delete();
    expect(await store.get()).toBeNull();
  });

  it("chiffre la clé du tunnel sans l'exposer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pronoteconnect-tunnel-store-"));
    const runtimeApiKey = `sk-${randomBytes(32).toString("base64url")}`;
    const store = new EncryptedFileTunnelSettingsStore(directory);
    const value = {
      schemaVersion: 1 as const,
      tunnelId: `tunnel_${randomBytes(20).toString("hex")}`,
      runtimeApiKey,
      pluginAppId: `plugin_asdk_app_${randomBytes(20).toString("hex")}`,
      updatedAt: new Date().toISOString(),
    };
    await store.set(value);
    const encrypted = await readFile(join(directory, "tunnel.enc"), "utf8");
    expect(encrypted).not.toContain(runtimeApiKey);
    expect(encrypted).not.toContain(value.tunnelId);
    expect(await store.get()).toEqual(value);
    await store.delete();
    expect(await store.get()).toBeNull();
  });
});

describe("redaction des journaux", () => {
  it("masque les champs sensibles et les secrets connus", () => {
    const secret = randomBytes(24).toString("base64url");
    const result = redact({ loginState: { mdp: secret }, nested: `valeur=${secret}` }, [secret]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("masque les en-têtes bearer", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: Bearer [REDACTED]");
  });
});
