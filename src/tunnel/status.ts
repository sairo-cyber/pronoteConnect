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
  lastError?: string;
  retryAttempt?: number;
  message: string;
}

export interface TunnelManagerOptions {
  dataDir: string;
  installDir: string;
  clientPath?: string;
  settingsStore: TunnelSettingsStore;
  logger: SafeLogger;
  mcpServerUrl?: string;
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

interface CommandResult {
  code: number;
  output: string;
  timedOut: boolean;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 45_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      if (output.length < 64_000) output += chunk.toString("utf8").slice(0, 64_000 - output.length);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output, timedOut });
    });
  });
}

export function classifyTunnelFailure(result: CommandResult, fallback: string): string {
  const output = result.output.toLowerCase();
  if (result.timedOut) return "TUNNEL_COMMAND_TIMEOUT";
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|api key|permission/iu.test(output)) return "TUNNEL_AUTH_REJECTED";
  if (/\b404\b|tunnel[^\n]{0,80}not found|unknown tunnel/iu.test(output)) return "TUNNEL_NOT_FOUND";
  if (/address already in use|bind[^\n]{0,80}(?:failed|error)/iu.test(output)) return "TUNNEL_LOCAL_PORT_BUSY";
  if (/timed? out|connection (?:refused|reset)|network|dns|lookup|resolve|unreachable/iu.test(output)) return "TUNNEL_NETWORK_ERROR";
  return fallback;
}

export function buildTunnelInitArguments(
  profileDir: string,
  tunnelId: string,
  target: { mcpServerUrl?: string; mcpCommand?: string },
): string[] {
  const base = [
    "init",
    "--force",
    "--sample", target.mcpServerUrl ? "sample_mcp_remote_no_auth" : "sample_mcp_stdio_local",
    "--profile", "pronoteconnect",
    "--profile-dir", profileDir,
    "--health-listen-addr", "127.0.0.1:0",
    "--tunnel-id", tunnelId,
  ];
  if (target.mcpServerUrl) return [...base, "--mcp-server-url", target.mcpServerUrl];
  if (target.mcpCommand) return [...base, "--mcp-command", target.mcpCommand];
  throw new Error("TUNNEL_TARGET_MISSING");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function failureMessage(code: string): string {
  const messages: Record<string, string> = {
    TUNNEL_AUTH_REJECTED: "La clé du tunnel est refusée ou ne possède pas les droits Tunnels Read et Use.",
    TUNNEL_NOT_FOUND: "Le tunnel est introuvable dans l'organisation OpenAI associée à cette clé.",
    TUNNEL_LOCAL_PORT_BUSY: "Le port de contrôle local du tunnel est déjà utilisé.",
    TUNNEL_NETWORK_ERROR: "Le tunnel ne peut pas joindre OpenAI. Vérifiez Internet, le pare-feu et le proxy.",
    TUNNEL_COMMAND_TIMEOUT: "Le client du tunnel ne répond pas dans le délai prévu.",
    TUNNEL_PROFILE_FAILED: "Le profil local du tunnel n'a pas pu être créé.",
    TUNNEL_CONFIGURATION_FAILED: "La vérification du tunnel a échoué.",
    TUNNEL_START_FAILED: "Le client du tunnel n'a pas pu démarrer.",
    TUNNEL_STOPPED: "Le client du tunnel s'est arrêté de façon inattendue.",
    TUNNEL_NOT_READY: "Le tunnel a démarré mais n'est pas devenu prêt.",
  };
  return messages[code] ?? "Le tunnel a rencontré une erreur inconnue.";
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
  readonly #mcpServerUrl: string | undefined;
  readonly #nodePath: string;
  readonly #stdioEntry: string;
  readonly #profileDir: string;
  readonly #healthUrlFile: string;
  #child: ChildProcess | undefined;
  #wanted = false;
  #restartTimer: NodeJS.Timeout | undefined;
  #readinessTimer: NodeJS.Timeout | undefined;
  #retryAttempt = 0;
  #lastError: string | undefined;

  constructor(options: TunnelManagerOptions) {
    this.#dataDir = options.dataDir;
    this.#installDir = options.installDir;
    this.#configuredClientPath = options.clientPath;
    this.#settingsStore = options.settingsStore;
    this.#logger = options.logger;
    this.#mcpServerUrl = options.mcpServerUrl ?? (process.platform === "win32" ? "http://127.0.0.1:37421/mcp" : undefined);
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
    await mkdir(this.#profileDir, { recursive: true, mode: 0o700 });
    const target = this.#mcpServerUrl
      ? { mcpServerUrl: this.#mcpServerUrl }
      : { mcpCommand: await this.#writeMcpLauncher() };
    const result = await run(client, buildTunnelInitArguments(this.#profileDir, settings.tunnelId, target), this.#environment(settings));
    if (result.code !== 0) throw new Error(classifyTunnelFailure(result, "TUNNEL_PROFILE_FAILED"));
  }

  async #doctor(settings: TunnelSettings): Promise<void> {
    const client = await this.#clientPath();
    if (!client) throw new Error("TUNNEL_CLIENT_MISSING");
    const result = await run(client, [
      "doctor",
      "--profile", "pronoteconnect",
      "--profile-dir", this.#profileDir,
      "--explain",
    ], this.#environment(settings));
    if (result.code !== 0) throw new Error(classifyTunnelFailure(result, "TUNNEL_CONFIGURATION_FAILED"));
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
    try {
      await this.#prepare(settings);
      await this.#doctor(settings);
    } catch (error) {
      this.#recordFailure(error instanceof Error ? error.message : "TUNNEL_CONFIGURATION_FAILED");
      throw error;
    }
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
    if (!client) {
      this.#lastError = "TUNNEL_CLIENT_MISSING";
      return;
    }
    try {
      await this.#prepare(settings);
    } catch (error) {
      this.#recordFailure(error instanceof Error ? error.message : "TUNNEL_PROFILE_FAILED");
      this.#scheduleRestart();
      return;
    }
    await rm(this.#healthUrlFile, { force: true });
    let output = "";
    const collect = (chunk: Buffer): void => {
      if (output.length < 64_000) output += chunk.toString("utf8").slice(0, 64_000 - output.length);
    };
    const child = spawn(client, [
      "run",
      "--profile", "pronoteconnect",
      "--profile-dir", this.#profileDir,
      "--health.url-file", this.#healthUrlFile,
    ], { env: this.#environment(settings), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.#child = child;
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () => {
      this.#recordFailure("TUNNEL_START_FAILED");
    });
    child.once("close", (code) => {
      if (this.#child === child) this.#child = undefined;
      if (this.#wanted) {
        const result: CommandResult = { code: code ?? 1, output, timedOut: false };
        if (this.#lastError !== "TUNNEL_NOT_READY") {
          this.#recordFailure(classifyTunnelFailure(result, "TUNNEL_STOPPED"));
        }
        this.#scheduleRestart();
      }
    });
    if (process.platform === "win32") {
      this.#readinessTimer = setTimeout(() => {
        void this.#confirmReady(child);
      }, 1_000);
    }
  }

  #recordFailure(code: string): void {
    this.#lastError = code;
    this.#logger.warn("Le tunnel privé doit être relancé.", { reason: code });
  }

  #scheduleRestart(): void {
    if (!this.#wanted || this.#restartTimer) return;
    this.#retryAttempt += 1;
    const delays = process.platform === "win32" ? [2_000, 5_000, 10_000, 30_000, 60_000] : [5_000];
    const delay = delays[Math.min(this.#retryAttempt - 1, delays.length - 1)] ?? 5_000;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.start().catch(() => {
        this.#recordFailure("TUNNEL_START_FAILED");
        this.#scheduleRestart();
      });
    }, delay);
  }

  async #ready(): Promise<boolean> {
    try {
      const base = localHealthUrl(await readFile(this.#healthUrlFile, "utf8"));
      const response = await fetch(new URL("/readyz", base), {
        signal: AbortSignal.timeout(1_500),
        redirect: "error",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async #confirmReady(child: ChildProcess, attempts = 30): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!this.#wanted || this.#child !== child || child.exitCode !== null) return;
      if (await this.#ready()) {
        this.#retryAttempt = 0;
        this.#lastError = undefined;
        this.#logger.info("Le tunnel privé est prêt.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (this.#wanted && this.#child === child && child.exitCode === null) {
      this.#recordFailure("TUNNEL_NOT_READY");
      child.kill();
    }
  }

  async stop(): Promise<void> {
    this.#wanted = false;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    if (this.#readinessTimer) clearTimeout(this.#readinessTimer);
    this.#restartTimer = undefined;
    this.#readinessTimer = undefined;
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
    this.#retryAttempt = 0;
    this.#lastError = undefined;
    await this.start();
  }

  async delete(): Promise<void> {
    await this.stop();
    await this.#settingsStore.delete();
    await rm(this.#profileDir, { recursive: true, force: true });
  }

  async status(): Promise<TunnelStatus> {
    const [client, settings] = await Promise.all([this.#clientPath(), this.#settingsStore.get()]);
    const active = Boolean(settings) && await this.#ready();
    if (active) {
      this.#retryAttempt = 0;
      this.#lastError = undefined;
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
            : this.#lastError
              ? `${failureMessage(this.#lastError)} Reconnexion automatique en cours.`
              : "Le tunnel démarre et vérifie sa connexion à OpenAI.",
    };
    if (settings?.tunnelId) status.tunnelId = settings.tunnelId;
    if (settings?.pluginAppId) status.pluginAppId = settings.pluginAppId;
    if (this.#settingsStore.warning) status.storageWarning = this.#settingsStore.warning;
    if (this.#lastError) status.lastError = failureMessage(this.#lastError);
    if (this.#retryAttempt > 0) status.retryAttempt = this.#retryAttempt;
    return status;
  }
}

export function parsePluginAppId(value: string): string {
  return pluginAppId(value);
}
