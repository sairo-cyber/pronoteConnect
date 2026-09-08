import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod/v4";

const TunnelSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  tunnelId: z.string().regex(/^tunnel_[A-Za-z0-9_-]{16,128}$/u),
  runtimeApiKey: z.string().min(20).max(512),
  pluginAppId: z.string().regex(/^plugin_asdk_app_[A-Za-z0-9_-]{16,128}$/u).optional(),
  updatedAt: z.string().datetime(),
}).strict();

export type TunnelSettings = z.infer<typeof TunnelSettingsSchema>;

export interface TunnelSettingsStore {
  readonly backend: "system-keyring" | "encrypted-local-fallback" | "memory";
  readonly warning?: string;
  get(): Promise<TunnelSettings | null>;
  set(value: TunnelSettings): Promise<void>;
  delete(): Promise<void>;
}

interface EncryptedEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

function run(command: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) child.kill();
      else stderr.push(chunk);
    });
    child.once("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(input);
  });
}

async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export class SecretToolTunnelSettingsStore implements TunnelSettingsStore {
  readonly backend = "system-keyring" as const;

  static async available(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    try {
      return (await run("secret-tool", ["--version"])).code === 0;
    } catch {
      return false;
    }
  }

  async get(): Promise<TunnelSettings | null> {
    const result = await run("secret-tool", ["lookup", "service", "pronoteconnect", "account", "tunnel"]);
    if (result.code !== 0 || !result.stdout.trim()) return null;
    return TunnelSettingsSchema.parse(JSON.parse(result.stdout.trim()));
  }

  async set(value: TunnelSettings): Promise<void> {
    const result = await run(
      "secret-tool",
      ["store", "--label=PronoteConnect", "service", "pronoteconnect", "account", "tunnel"],
      JSON.stringify(TunnelSettingsSchema.parse(value)),
    );
    if (result.code !== 0) throw new Error("TUNNEL_KEYRING_WRITE_FAILED");
  }

  async delete(): Promise<void> {
    const result = await run("secret-tool", ["clear", "service", "pronoteconnect", "account", "tunnel"]);
    if (result.code !== 0 && !/not found/iu.test(result.stderr)) throw new Error("TUNNEL_KEYRING_DELETE_FAILED");
  }
}

export class EncryptedFileTunnelSettingsStore implements TunnelSettingsStore {
  readonly backend = "encrypted-local-fallback" as const;
  readonly warning = "Le trousseau système est indisponible. La clé du tunnel est chiffrée dans le dossier local de PronoteConnect.";
  readonly #keyPath: string;
  readonly #secretPath: string;

  constructor(dataDir: string) {
    this.#keyPath = join(dataDir, "tunnel-master.key");
    this.#secretPath = join(dataDir, "tunnel.enc");
  }

  async #key(): Promise<Buffer> {
    try {
      const key = await readFile(this.#keyPath);
      if (key.byteLength !== 32) throw new Error("INVALID_TUNNEL_KEY");
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await atomicWrite(this.#keyPath, key);
      return key;
    }
  }

  async get(): Promise<TunnelSettings | null> {
    let raw: string;
    try {
      raw = await readFile(this.#secretPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const envelope = JSON.parse(raw) as EncryptedEnvelope;
    if (envelope.version !== 1) throw new Error("UNSUPPORTED_TUNNEL_SECRET_FORMAT");
    const decipher = createDecipheriv("aes-256-gcm", await this.#key(), Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const cleartext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return TunnelSettingsSchema.parse(JSON.parse(cleartext));
  }

  async set(value: TunnelSettings): Promise<void> {
    const cleartext = Buffer.from(JSON.stringify(TunnelSettingsSchema.parse(value)), "utf8");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await this.#key(), iv);
    const ciphertext = Buffer.concat([cipher.update(cleartext), cipher.final()]);
    cleartext.fill(0);
    const envelope: EncryptedEnvelope = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    await atomicWrite(this.#secretPath, JSON.stringify(envelope));
  }

  async delete(): Promise<void> {
    await rm(this.#secretPath, { force: true });
    await rm(this.#keyPath, { force: true });
  }
}

export class MemoryTunnelSettingsStore implements TunnelSettingsStore {
  readonly backend = "memory" as const;
  #value: TunnelSettings | null;

  constructor(initial: TunnelSettings | null = null) {
    this.#value = initial ? structuredClone(initial) : null;
  }

  async get(): Promise<TunnelSettings | null> {
    return this.#value ? structuredClone(this.#value) : null;
  }

  async set(value: TunnelSettings): Promise<void> {
    this.#value = structuredClone(TunnelSettingsSchema.parse(value));
  }

  async delete(): Promise<void> {
    this.#value = null;
  }
}

export async function createTunnelSettingsStore(dataDir: string): Promise<TunnelSettingsStore> {
  if (await SecretToolTunnelSettingsStore.available()) return new SecretToolTunnelSettingsStore();
  return new EncryptedFileTunnelSettingsStore(dataDir);
}

export function parseTunnelSettings(value: unknown): TunnelSettings {
  return TunnelSettingsSchema.parse(value);
}
