import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CitySearchInputSchema, NormalizedUrlInputSchema, SchoolSearchInputSchema } from "../domain/schemas.js";
import type { Runtime } from "../runtime.js";
import { createPronoteMcpServer } from "../mcp/server.js";
import { APP_NAME, APP_VERSION } from "../config.js";
import { detectChromiumExecutable } from "../auth/browser-auth-provider.js";

function cookies(request: Request): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? "").split(";").flatMap((part) => {
      const index = part.indexOf("=");
      if (index < 0) return [];
      return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
    }),
  );
}

function equalSecret(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeApiMessage(error: unknown): { error: string; message: string } {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  const messages: Record<string, string> = {
    AUTH_ALREADY_RUNNING: "Une connexion est déjà en cours.",
    PIN_NOT_EXPECTED: "Aucun code PIN n'est attendu.",
    INVALID_PIN: "Le code PIN doit contenir exactement quatre chiffres.",
    NOT_A_LIKELY_PRONOTE_URL: "Cette URL ne ressemble pas à une instance PRONOTE.",
    STUDENT_SPACE_NOT_FOUND: "Aucun espace Élève n'a été trouvé.",
    LOCAL_PRONOTE_URL_FORBIDDEN: "Une URL PRONOTE locale n'est pas acceptée.",
    UNSUPPORTED_URL_SCHEME: "Seules les URL HTTP ou HTTPS sont acceptées.",
    URL_CREDENTIALS_FORBIDDEN: "Une URL contenant des identifiants est refusée.",
    CITY_SEARCH_FAILED: "La recherche de ville est momentanément indisponible.",
    PLAYWRIGHT_CHROMIUM_NOT_INSTALLED: "Chromium n'est pas installé. Relancez l'installateur.",
    TUNNEL_CLIENT_MISSING: "Le client du tunnel est absent. Relancez l'installateur.",
    TUNNEL_PROFILE_FAILED: "Le profil du tunnel n'a pas pu être créé.",
    TUNNEL_CONFIGURATION_FAILED: "La clé ou l'identifiant du tunnel n'est pas accepté. Vérifiez aussi les droits Tunnels Read et Use.",
    TUNNEL_NOT_CONFIGURED: "Configurez d'abord le tunnel.",
    INVALID_PLUGIN_APP_ID: "Collez l'adresse du plugin ou son identifiant commençant par plugin_asdk_app_.",
  };
  return { error: messages[code] ? code : "REQUEST_FAILED", message: messages[code] ?? "L'opération a échoué sans exposer de détail sensible." };
}

export function createHttpApp(runtime: Runtime) {
  const app = createMcpExpressApp({ host: runtime.config.host, allowedHosts: runtime.config.allowedHosts });
  const csrf = randomBytes(32).toString("base64url");
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });

  const requireCsrf = (request: Request, response: Response, next: NextFunction): void => {
    const header = request.header("x-pronoteconnect-csrf");
    const cookie = cookies(request).pc_session;
    if (!equalSecret(header, csrf) || !equalSecret(cookie, csrf)) {
      response.status(403).json({ error: "CSRF_REJECTED", message: "Rechargez l'interface locale." });
      return;
    }
    next();
  };

  app.get("/health", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ ok: true, service: "pronoteconnect", mcp: "/mcp" });
  });

  app.get("/api/bootstrap", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Set-Cookie", `pc_session=${encodeURIComponent(csrf)}; Path=/; HttpOnly; SameSite=Strict`);
    response.json({ csrf, mode: runtime.config.adapter });
  });

  app.get("/api/status", async (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const [connection, tunnel, browser] = await Promise.all([
      runtime.connector.connectionStatus(),
      runtime.tunnel?.status() ?? Promise.resolve({
        clientInstalled: false,
        configured: false,
        active: false,
        pluginConfigured: false,
        storageBackend: "memory" as const,
        message: "La gestion du tunnel est désactivée dans ce processus.",
      }),
      detectChromiumExecutable(),
    ]);
    response.json({
      app: {
        name: APP_NAME,
        version: APP_VERSION,
        installDir: runtime.config.installDir,
        platform: process.platform,
        managedService: runtime.config.managedService,
        browser: { available: browser.available, name: browser.name },
      },
      connection,
      auth: runtime.auth?.status() ?? { phase: "idle", message: "Mode de démonstration factice.", pinRequired: false },
      mcp: { active: true, transport: "streamable-http", endpoint: `http://${runtime.config.host}:${runtime.config.port}/mcp` },
      tunnel,
      mode: runtime.config.adapter,
      complete: connection.connected && tunnel.active && tunnel.pluginConfigured,
    });
  });

  app.post("/api/tunnel/configure", requireCsrf, async (request, response) => {
    if (!runtime.tunnel) {
      response.status(409).json({ error: "TUNNEL_MANAGER_DISABLED", message: "La gestion du tunnel est désactivée." });
      return;
    }
    try {
      const tunnel = await runtime.tunnel.configure(request.body);
      response.status(202).json({ tunnel });
    } catch (error) {
      response.status(400).json(safeApiMessage(error));
    }
  });

  app.post("/api/tunnel/restart", requireCsrf, async (_request, response) => {
    if (!runtime.tunnel) {
      response.status(409).json({ error: "TUNNEL_MANAGER_DISABLED", message: "La gestion du tunnel est désactivée." });
      return;
    }
    try {
      await runtime.tunnel.restart();
      response.status(202).json({ tunnel: await runtime.tunnel.status() });
    } catch (error) {
      response.status(400).json(safeApiMessage(error));
    }
  });

  app.post("/api/tunnel/plugin", requireCsrf, async (request, response) => {
    if (!runtime.tunnel) {
      response.status(409).json({ error: "TUNNEL_MANAGER_DISABLED", message: "La gestion du tunnel est désactivée." });
      return;
    }
    try {
      const value = typeof request.body?.plugin === "string" ? request.body.plugin : "";
      response.json({ tunnel: await runtime.tunnel.setPlugin(value) });
    } catch (error) {
      response.status(400).json(safeApiMessage(error));
    }
  });

  app.delete("/api/tunnel", requireCsrf, async (_request, response) => {
    if (!runtime.tunnel) {
      response.status(409).json({ error: "TUNNEL_MANAGER_DISABLED", message: "La gestion du tunnel est désactivée." });
      return;
    }
    try {
      await runtime.tunnel.delete();
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json(safeApiMessage(error));
    }
  });

  app.post("/api/cities/search", requireCsrf, async (request, response) => {
    try {
      const { query } = CitySearchInputSchema.parse(request.body);
      response.json({ cities: await runtime.connector.searchCities(query) });
    } catch (error) {
      response.status(400).json(safeApiMessage(error));
    }
  });

  app.post("/api/schools/search", requireCsrf, async (request, response) => {
    try {
      const { latitude, longitude } = SchoolSearchInputSchema.parse(request.body);
      response.json({ schools: await runtime.connector.searchSchools(latitude, longitude) });
    } catch (error) {
      response.status(400).json(safeApiMessage(error));
    }
  });

  app.post("/api/instance/validate", requireCsrf, async (request, response) => {
    try {
      const { url } = NormalizedUrlInputSchema.parse(request.body);
      response.json({ instance: await runtime.connector.validateInstance(url) });
    } catch (error) {
      response.status(400).json(safeApiMessage(error));
    }
  });

  app.post("/api/auth/start", requireCsrf, async (request, response) => {
    if (!runtime.auth) {
      response.status(409).json({ error: "FAKE_MODE", message: "La démonstration factice est déjà connectée." });
      return;
    }
    try {
      const { url } = NormalizedUrlInputSchema.parse(request.body);
      await runtime.auth.start(url);
      response.status(202).json({ auth: runtime.auth.status() });
    } catch (error) {
      response.status(400).json(safeApiMessage(error));
    }
  });

  app.post("/api/auth/pin", requireCsrf, async (request, response) => {
    if (!runtime.auth) {
      response.status(409).json({ error: "FAKE_MODE", message: "Aucun code PIN n'est attendu en démonstration." });
      return;
    }
    try {
      const pin = typeof request.body?.pin === "string" ? request.body.pin : "";
      await runtime.auth.submitPin(pin);
      response.json({ auth: runtime.auth.status() });
    } catch (error) {
      response.status(400).json(safeApiMessage(error));
    }
  });

  app.post("/api/auth/cancel", requireCsrf, async (_request, response) => {
    await runtime.auth?.cancel();
    response.json({ ok: true });
  });

  app.post("/api/disconnect", requireCsrf, async (_request, response) => {
    try {
      await runtime.auth?.cancel();
      await runtime.connector.disconnect();
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json(safeApiMessage(error));
    }
  });

  app.post("/api/documents/clear", requireCsrf, async (_request, response) => {
    try {
      await runtime.connector.clearDocumentCache();
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json(safeApiMessage(error));
    }
  });

  app.delete("/api/local-data", requireCsrf, async (_request, response) => {
    try {
      await runtime.auth?.cancel();
      await runtime.connector.deleteAllLocalData();
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json(safeApiMessage(error));
    }
  });

  app.post("/mcp", async (request, response) => {
    const server = createPronoteMcpServer(runtime.controller);
    const transport = new StreamableHTTPServerTransport();
    try {
      // le sdk expose une classe concrète plus large que son type transport
      await server.connect(transport as unknown as Transport);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        response.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_request: Request, response: Response): void => {
    response.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const publicDir = join(runtime.config.installDir, "public");
  app.use(express.static(publicDir, { index: "index.html", etag: false, maxAge: 0 }));
  return app;
}
