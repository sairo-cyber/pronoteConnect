import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { PronoteConnector } from "./pronote/connector.js";
import { FakePronoteConnector } from "./pronote/fake-connector.js";
import { RealPronoteConnector } from "./pronote/real-connector.js";
import { createCredentialStore, type CredentialStore } from "./storage/credential-store.js";
import { loadOrCreateOpaqueKey, OpaqueIdService } from "./security/opaque-ids.js";
import { createSafeLogger, type SafeLogger } from "./security/redaction.js";
import { DocumentReader } from "./documents/document-reader.js";
import { PlaywrightBrowserAuthProvider, type BrowserAuthProvider } from "./auth/browser-auth-provider.js";
import { AuthCoordinator } from "./auth/auth-coordinator.js";
import { ToolController } from "./mcp/tool-controller.js";
import { createTunnelSettingsStore, type TunnelSettingsStore } from "./storage/tunnel-settings-store.js";
import { TunnelManager } from "./tunnel/status.js";

export interface Runtime {
  config: AppConfig;
  connector: PronoteConnector;
  controller: ToolController;
  auth?: AuthCoordinator;
  tunnel?: TunnelManager;
  logger: SafeLogger;
}

export interface RuntimeOverrides {
  connector?: PronoteConnector;
  credentialStore?: CredentialStore;
  browserAuthProvider?: BrowserAuthProvider;
  tunnelSettingsStore?: TunnelSettingsStore;
  tunnel?: TunnelManager;
  logger?: SafeLogger;
}

export async function createRuntime(config: AppConfig, overrides: RuntimeOverrides = {}): Promise<Runtime> {
  const logger = overrides.logger ?? createSafeLogger();
  let tunnel = overrides.tunnel;
  if (!tunnel && config.superviseTunnel) {
    tunnel = new TunnelManager({
      dataDir: config.dataDir,
      installDir: config.installDir,
      settingsStore: overrides.tunnelSettingsStore ?? await createTunnelSettingsStore(config.dataDir),
      logger,
      ...(process.platform === "win32" ? { mcpServerUrl: `http://127.0.0.1:${config.port}/mcp` } : {}),
      ...(config.tunnelClientPath ? { clientPath: config.tunnelClientPath } : {}),
    });
    await tunnel.start();
  }
  if (overrides.connector) {
    return { config, connector: overrides.connector, controller: new ToolController(overrides.connector), logger, ...(tunnel ? { tunnel } : {}) };
  }
  if (config.adapter === "fake") {
    const connector = new FakePronoteConnector();
    return { config, connector, controller: new ToolController(connector), logger, ...(tunnel ? { tunnel } : {}) };
  }
  const credentialStore = overrides.credentialStore ?? await createCredentialStore(config.dataDir);
  const key = await loadOrCreateOpaqueKey(join(config.dataDir, "opaque-ids.key"));
  const connector = new RealPronoteConnector({
    credentialStore,
    ids: new OpaqueIdService(key),
    documents: new DocumentReader({ cacheDir: join(config.dataDir, "documents") }),
    logger,
    dataDir: config.dataDir,
  });
  const auth = new AuthCoordinator(
    overrides.browserAuthProvider ?? new PlaywrightBrowserAuthProvider(),
    connector,
    logger,
  );
  return { config, connector, controller: new ToolController(connector), auth, logger, ...(tunnel ? { tunnel } : {}) };
}
