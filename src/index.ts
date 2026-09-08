import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { createHttpApp } from "./http/app.js";

const config = loadConfig();
if (!["127.0.0.1", "localhost", "::1"].includes(config.host) && process.env.PRONOTECONNECT_ALLOW_NON_LOOPBACK !== "1") {
  throw new Error("Refus de lier le serveur hors boucle locale sans PRONOTECONNECT_ALLOW_NON_LOOPBACK=1.");
}
const runtime = await createRuntime(config);
const app = createHttpApp(runtime);
const servers = [createServer(app)];

await new Promise<void>((resolve, reject) => {
  servers[0]?.once("error", reject);
  servers[0]?.listen(config.port, config.host, () => resolve());
});
if (config.tailscaleHost) {
  const tailscaleServer = createServer(app);
  try {
    await new Promise<void>((resolve, reject) => {
      tailscaleServer.once("error", reject);
      tailscaleServer.listen(config.port, config.tailscaleHost, () => resolve());
    });
    servers.push(tailscaleServer);
  } catch {
    runtime.logger.warn("L'adresse Tailscale n'est pas disponible. L'interface reste accessible localement.");
  }
}
runtime.logger.info("PronoteConnect démarré.", {
  interface: `http://${config.host}:${config.port}`,
  tailscale: config.tailscaleHost ? `http://${config.tailscaleHost}:${config.port}` : undefined,
  mcp: `http://${config.host}:${config.port}/mcp`,
  adapter: config.adapter,
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runtime.auth?.cancel();
  await runtime.tunnel?.stop();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}
process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
