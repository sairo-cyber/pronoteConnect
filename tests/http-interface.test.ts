import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHttpApp } from "../src/http/app.js";
import { createRuntime } from "../src/runtime.js";
import { loadConfig } from "../src/config.js";
import { FakePronoteConnector } from "../src/pronote/fake-connector.js";

const servers: Server[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })));
});

async function testDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "pronoteconnect-http-"));
  dataDirs.push(dataDir);
  return dataDir;
}

describe("interface locale", () => {
  it("sert l'interface, l'état et protège les mutations par CSRF", async () => {
    const config = loadConfig({
      adapter: "fake",
      port: 37_421,
      host: "127.0.0.1",
      allowedHosts: ["127.0.0.1", "localhost", "[::1]", "100.64.0.1"],
      dataDir: await testDataDir(),
    });
    const runtime = await createRuntime(config, { connector: new FakePronoteConnector() });
    const app = createHttpApp(runtime);
    await request(app).get("/").set("Host", "127.0.0.1").expect(200).expect(/PronoteConnect/u);
    await request(app).get("/health").set("Host", "100.64.0.1:37421").expect(200);
    await request(app).get("/health").set("Host", "192.168.1.20:37421").expect(403);
    await request(app).get("/api/status").set("Host", "127.0.0.1").expect(200).expect((response) => {
      expect(response.body.connection.connected).toBe(true);
      expect(response.body.mcp.active).toBe(true);
    });
    await request(app).post("/api/documents/clear").set("Host", "127.0.0.1").send({}).expect(403);

    const agent = request.agent(app);
    const bootstrap = await agent.get("/api/bootstrap").set("Host", "127.0.0.1").expect(200);
    await agent.post("/api/documents/clear").set("Host", "127.0.0.1").set("X-PronoteConnect-CSRF", bootstrap.body.csrf).send({}).expect(200);
  });

  it("démarre et arrête un vrai endpoint Streamable HTTP", async () => {
    const config = loadConfig({ adapter: "fake", port: 0, host: "127.0.0.1", dataDir: await testDataDir() });
    const runtime = await createRuntime(config, { connector: new FakePronoteConnector() });
    const server = createServer(createHttpApp(runtime));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    await client.connect(transport as unknown as Transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(8);
    await client.close();
  });
});
