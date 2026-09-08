import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod/v4";
import type { StoredCredential } from "../domain/types.js";

const CredentialSchema = z.object({
  schemaVersion: z.literal(1),
  pronoteUrl: z.string().url(),
  username: z.string().min(1),
  accountKind: z.literal("STUDENT"),
  deviceUUID: z.string().min(16),
  token: z.string().min(1),
  navigatorIdentifier: z.string().optional(),
  establishmentName: z.string().optional(),
  className: z.string().optional(),
  lastConnectedAt: z.string().datetime(),
}).strict();

export interface CredentialStore {
  readonly backend: "system-keyring" | "encrypted-local-fallback" | "memory";
  readonly warning?: string;
  get(): Promise<StoredCredential | null>;
  set(value: StoredCredential): Promise<void>;
  delete(): Promise<void>;
}

function parseCredential(value: string): StoredCredential {
  return CredentialSchema.parse(JSON.parse(value)) as StoredCredential;
}

function spawnBuffered(
  command: string,
  args: string[],
  input?: string,
  maxOutput = 2 * 1024 * 1024,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > maxOutput) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > maxOutput) child.kill();
      else stderr.push(chunk);
    });
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export class SecretToolCredentialStore implements CredentialStore {
  readonly backend = "system-keyring" as const;

  static async available(): Promise<boolean> {
    if (process.platform !== "linux") return false;
    try {
      return (await spawnBuffered("secret-tool", ["--version"])).code === 0;
    } catch {
      return false;
    }
  }

  async get(): Promise<StoredCredential | null> {
    const result = await spawnBuffered("secret-tool", ["lookup", "service", "pronoteconnect", "account", "default"]);
    return result.code === 0 && result.stdout.trim() ? parseCredential(result.stdout.trim()) : null;
  }

  async set(value: StoredCredential): Promise<void> {
    const parsed = CredentialSchema.parse(value);
    const result = await spawnBuffered(
      "secret-tool",
      ["store", "--label=PronoteConnect", "service", "pronoteconnect", "account", "default"],
      JSON.stringify(parsed),
    );
    if (result.code !== 0) throw new Error("KEYRING_WRITE_FAILED");
  }

  async delete(): Promise<void> {
    const result = await spawnBuffered("secret-tool", ["clear", "service", "pronoteconnect", "account", "default"]);
    if (result.code !== 0 && !/not found/iu.test(result.stderr)) throw new Error("KEYRING_DELETE_FAILED");
  }
}

interface EncryptedEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

async function atomicPrivateWrite(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

export class EncryptedFileCredentialStore implements CredentialStore {
  readonly backend = "encrypted-local-fallback" as const;
  readonly warning = "Le trousseau système est indisponible. Le jeton est chiffré dans le dossier local de PronoteConnect.";
  readonly #keyPath: string;
  readonly #secretPath: string;

  constructor(dataDir: string) {
    this.#keyPath = join(dataDir, "fallback-master.key");
    this.#secretPath = join(dataDir, "credentials.enc");
  }

  async #key(): Promise<Buffer> {
    try {
      const key = await readFile(this.#keyPath);
      if (key.byteLength !== 32) throw new Error("INVALID_LOCAL_KEY");
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await atomicPrivateWrite(this.#keyPath, key);
      return key;
    }
  }

  async get(): Promise<StoredCredential | null> {
    let raw: string;
    try {
      raw = await readFile(this.#secretPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const envelope = JSON.parse(raw) as EncryptedEnvelope;
    if (envelope.version !== 1) throw new Error("UNSUPPORTED_SECRET_FORMAT");
    const decipher = createDecipheriv("aes-256-gcm", await this.#key(), Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const cleartext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return parseCredential(cleartext);
  }

  async set(value: StoredCredential): Promise<void> {
    const cleartext = Buffer.from(JSON.stringify(CredentialSchema.parse(value)), "utf8");
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
    await atomicPrivateWrite(this.#secretPath, JSON.stringify(envelope));
  }

  async delete(): Promise<void> {
    await rm(this.#secretPath, { force: true });
    await rm(this.#keyPath, { force: true });
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly backend = "memory" as const;
  #value: StoredCredential | null;

  constructor(initial: StoredCredential | null = null) {
    this.#value = initial ? structuredClone(initial) : null;
  }

  async get(): Promise<StoredCredential | null> {
    return this.#value ? structuredClone(this.#value) : null;
  }

  async set(value: StoredCredential): Promise<void> {
    this.#value = structuredClone(CredentialSchema.parse(value) as StoredCredential);
  }

  async delete(): Promise<void> {
    this.#value = null;
  }
}

export async function createCredentialStore(dataDir: string): Promise<CredentialStore> {
  if (await SecretToolCredentialStore.available()) return new SecretToolCredentialStore();
  return new EncryptedFileCredentialStore(dataDir);
}
