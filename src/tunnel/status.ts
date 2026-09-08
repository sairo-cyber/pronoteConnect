import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { z } from "zod/v4";
import type { SafeLogger } from "../security/redaction.js";
import type { TunnelSettings, TunnelSettingsStore } from "../storage/tunnel-settings-store.js";

const TunnelInputSchema = z.object({
  tunnelId: z.string().trim().regex(/^tunnel_[A-Za-z0-9_-]{16,128}$/u),
  runtimeApiKey: z.string().trim().min(20).max(512),
}).strict();

const PluginInputSchema = z.string().trim().min(1).max(2_048);

export interface TunnelStatus {
  clientInstalled: boolean;
  configured: boolean;
  active: boolean;
  pluginConfigured: boolean;
  tunnelId?: string;
  pluginAppId?: string;
  storageBackend: TunnelSettingsStore["backend"];
  storageWarning?: string;
  message: string;
}

export interface TunnelManagerOptions {
  dataDir: string;
  installDir: string;
  clientPath?: string;
  settingsStore: TunnelSettingsStore;
  logger: SafeLogger;
  nodePath?: string;
  stdioEntry?: string;
}

function executableName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findInPath(name: string): Promise<string | undefined> {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    for (const suffix of suffixes) {
      const candidate = join(folder, `${name}${suffix}`);
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 45_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore" });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function pluginAppId(value: string): string {
  const match = PluginInputSchema.parse(value).match(/plugin_asdk_app_[A-Za-z0-9_-]{16,128}/u);
  if (!match) throw new Error("INVALID_PLUGIN_APP_ID");
  return match[0];
}

function localHealthUrl(value: string): URL {
  const url = new URL(value.trim());
  if (url.protocol !== "http:") throw new Error("INVALID_TUNNEL_HEALTH_URL");
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) throw new Error("INVALID_TUNNEL_HEALTH_URL");
  return url;
}

export class TunnelManager {
  readonly #dataDir: string;
  readonly #installDir: string;
  readonly #configuredClientPath: string | undefined;
  readonly #settingsStore: TunnelSettingsStore;
  readonly #logger: SafeLogger;
  readonly #nodePath: string;
  readonly #stdioEntry: string;
  readonly #profileDir: string;
  readonly #healthUrlFile: string;
  #child: ChildProcess | undefined;
  #wanted = false;
  #restartTimer: NodeJS.Timeout | undefined;

  constructor(options: TunnelManagerOptions) {
    this.#dataDir = options.dataDir;
    this.#installDir = options.installDir;
    this.#configuredClientPath = options.clientPath;
    this.#settingsStore = options.settingsStore;
    this.#logger = options.logger;
    this.#nodePath = options.nodePath ?? process.execPath;
    this.#stdioEntry = options.stdioEntry ?? join(options.installDir, "dist", "src", "stdio.js");
    this.#profileDir = join(options.dataDir, "tunnel");
    this.#healthUrlFile = join(this.#profileDir, "health-url.txt");
  }

  async #clientPath(): Promise<string | undefined> {
    const candidates = [
      this.#configuredClientPath,
      join(this.#installDir, ".runtime", "tunnel-client", executableName("tunnel-client")),
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
      if (await executable(candidate)) return candidate;
    }
    return findInPath("tunnel-client");
  }

  #environment(settings: TunnelSettings): NodeJS.ProcessEnv {
    const clientDirectory = this.#configuredClientPath
      ? dirname(this.#configuredClientPath)
      : join(this.#installDir, ".runtime", "tunnel-client");
    return {
      ...process.env,
      CONTROL_PLANE_API_KEY: settings.runtimeApiKey,
      CLOUDFLARED_PATH: join(clientDirectory, executableName("cloudflared")),
    };
  }

  async #writeMcpLauncher(): Promise<string> {
    await mkdir(this.#profileDir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      const path = join(this.#profileDir, "mcp-stdio.cmd");
      const content = [
        "@echo off",
        "set CONTROL_PLANE_API_KEY=",
        "set OPENAI_API_KEY=",
        "set PRONOTECONNECT_SUPERVISE_TUNNEL=0",
        `set "PRONOTECONNECT_DATA_DIR=${this.#dataDir}"`,
        `"${this.#nodePath}" "${this.#stdioEntry}"`,
        "",
      ].join("\r\n");
      await writeFile(path, content, { mode: 0o600 });
      return `cmd /d /s /c "${path}"`;
    }
    const path = join(this.#profileDir, "mcp-stdio.sh");
    const content = [
      "#!/usr/bin/env sh",
      "unset CONTROL_PLANE_API_KEY OPENAI_API_KEY",
      "export PRONOTECONNECT_SUPERVISE_TUNNEL=0",
      `export PRONOTECONNECT_DATA_DIR=${shellQuote(this.#dataDir)}`,
      `exec ${shellQuote(this.#nodePath)} ${shellQuote(this.#stdioEntry)}`,
      "",
    ].join("\n");
    await writeFile(path, content, { mode: 0o700 });
    await chmod(path, 0o700);
    return path;
  }

  async #prepare(settings: TunnelSettings): Promise<void> {
    const client = await this.#clientPath();
    if (!client) throw new Error("TUNNEL_CLIENT_MISSING");
    const mcpCommand = await this.#writeMcpLauncher();
    const code = await run(client, [
      "init",
      "--force",
      "--sample", "sample_mcp_stdio_local",
      "--profile", "pronoteconnect",
      "--profile-dir", this.#profileDir,
      "--health-listen-addr", "127.0.0.1:0",
      "--tunnel-id", settings.tunnelId,
      "--mcp-command", mcpCommand,
    ], this.#environment(settings));
    if (code !== 0) throw new Error("TUNNEL_PROFILE_FAILED");
  }

  async #doctor(settings: TunnelSettings): Promise<void> {
    const client = await this.#clientPath();
    if (!client) throw new Error("TUNNEL_CLIENT_MISSING");
    const code = await run(client, [
      "doctor",
      "--profile", "pronoteconnect",
      "--profile-dir", this.#profileDir,
      "--explain",
    ], this.#environment(settings));
    if (code !== 0) throw new Error("TUNNEL_CONFIGURATION_FAILED");
  }

  async configure(input: unknown): Promise<TunnelStatus> {
    const parsed = TunnelInputSchema.parse(input);
    const previous = await this.#settingsStore.get();
    const settings: TunnelSettings = {
      schemaVersion: 1,
      tunnelId: parsed.tunnelId,
      runtimeApiKey: parsed.runtimeApiKey,
      updatedAt: new Date().toISOString(),
      ...(previous?.pluginAppId ? { pluginAppId: previous.pluginAppId } : {}),
    };
    await this.#prepare(settings);
    await this.#doctor(settings);
    await this.#settingsStore.set(settings);
    await this.restart();
    return this.status();
  }

  async setPlugin(value: string): Promise<TunnelStatus> {
    const current = await this.#settingsStore.get();
    if (!current) throw new Error("TUNNEL_NOT_CONFIGURED");
    await this.#settingsStore.set({
      ...current,
      pluginAppId: pluginAppId(value),
      updatedAt: new Date().toISOString(),
    });
    return this.status();
  }

  async start(): Promise<void> {
    this.#wanted = true;
    if (this.#child && this.#child.exitCode === null) return;
    const settings = await this.#settingsStore.get();
    if (!settings) return;
    const client = await this.#clientPath();
    if (!client) return;
    await this.#prepare(settings);
    await rm(this.#healthUrlFile, { force: true });
    const child = spawn(client, [
      "run",
      "--profile", "pronoteconnect",
      "--profile-dir", this.#profileDir,
      "--health.url-file", this.#healthUrlFile,
    ], { env: this.#environment(settings), stdio: "ignore" });
    this.#child = child;
    child.once("error", () => {
      this.#logger.error("Le client du tunnel n'a pas démarré.");
    });
    child.once("close", () => {
      if (this.#child === child) this.#child = undefined;
      if (this.#wanted) {
        this.#restartTimer = setTimeout(() => {
          void this.start().catch(() => undefined);
        }, 5_000);
      }
    });
  }

  async stop(): Promise<void> {
    this.#wanted = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async delete(): Promise<void> {
    await this.stop();
    await this.#settingsStore.delete();
    await rm(this.#profileDir, { recursive: true, force: true });
  }

  async status(): Promise<TunnelStatus> {
    const [client, settings] = await Promise.all([this.#clientPath(), this.#settingsStore.get()]);
    let active = false;
    if (settings) {
      try {
        const base = localHealthUrl(await readFile(this.#healthUrlFile, "utf8"));
        const response = await fetch(new URL("/readyz", base), {
          signal: AbortSignal.timeout(1_500),
          redirect: "error",
        });
        active = response.ok;
      } catch {
        active = false;
      }
    }
    const status: TunnelStatus = {
      clientInstalled: Boolean(client),
      configured: Boolean(settings),
      active,
      pluginConfigured: Boolean(settings?.pluginAppId),
      storageBackend: this.#settingsStore.backend,
      message: !client
        ? "Le client du tunnel n'est pas installé. Relancez l'installateur."
        : !settings
          ? "Créez votre tunnel OpenAI puis enregistrez sa clé."
          : active
            ? "Le tunnel privé est actif."
            : "Le tunnel est configuré mais ne répond pas encore.",
    };
    if (settings?.tunnelId) status.tunnelId = settings.tunnelId;
    if (settings?.pluginAppId) status.pluginAppId = settings.pluginAppId;
    if (this.#settingsStore.warning) status.storageWarning = this.#settingsStore.warning;
    return status;
  }
}

export function parsePluginAppId(value: string): string {
  return pluginAppId(value);
}
