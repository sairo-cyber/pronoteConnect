import { join, resolve } from "node:path";

export const APP_NAME = "PronoteConnect";
export const APP_VERSION = "0.3.0";
export const TIME_ZONE = "Europe/Paris";
export const DEFAULT_PORT = 37_421;
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_RETURNED_TEXT_CHARS = 60_000;

export interface AppConfig {
  host: string;
  allowedHosts: string[];
  tailscaleHost?: string;
  port: number;
  dataDir: string;
  installDir: string;
  adapter: "real" | "fake";
  tunnelClientPath?: string;
  managedService: boolean;
  superviseTunnel: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const configuredPort = Number(process.env.PRONOTECONNECT_PORT ?? DEFAULT_PORT);
  const adapter = process.env.PRONOTECONNECT_ADAPTER === "fake" ? "fake" : "real";
  const installDir = resolve(process.env.PRONOTECONNECT_INSTALL_DIR ?? process.cwd());
  const configuredTailscaleHost = process.env.PRONOTECONNECT_TAILSCALE_HOST?.trim();
  const tailscaleHost = configuredTailscaleHost && isTailscaleIpv4(configuredTailscaleHost) ? configuredTailscaleHost : undefined;
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]", ...(tailscaleHost ? [tailscaleHost] : [])]
    .map((host) => host.trim().toLowerCase())
    .filter((host, index, hosts) => host.length > 0 && hosts.indexOf(host) === index);

  const base: AppConfig = {
    host: process.env.PRONOTECONNECT_HOST ?? "127.0.0.1",
    allowedHosts,
    port: Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : DEFAULT_PORT,
    dataDir: resolve(process.env.PRONOTECONNECT_DATA_DIR ?? join(installDir, ".data")),
    installDir,
    adapter,
    managedService: process.env.PRONOTECONNECT_MANAGED_SERVICE === "1",
    superviseTunnel: process.env.PRONOTECONNECT_SUPERVISE_TUNNEL !== "0",
  };
  if (tailscaleHost) base.tailscaleHost = tailscaleHost;
  const tunnelClientPath = process.env.PRONOTECONNECT_TUNNEL_CLIENT;
  if (tunnelClientPath) base.tunnelClientPath = resolve(tunnelClientPath);
  return { ...base, ...overrides };
}

function isTailscaleIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 100
    && parts[1] !== undefined
    && parts[1] >= 64
    && parts[1] <= 127;
}
