import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FakePronoteConnector } from "../src/pronote/fake-connector.js";
import { ToolController } from "../src/mcp/tool-controller.js";
import { createPronoteMcpServer } from "../src/mcp/server.js";

function dataOf(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return (result.structuredContent as { data?: unknown } | undefined)?.data;
}

describe("serveur MCP PronoteConnect", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server = createPronoteMcpServer(new ToolController(new FakePronoteConnector()));
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await Promise.all([client.close(), server.close()]);
  });

  it("expose exactement les huit outils de lecture requis", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "pronote_connection_status",
      "pronote_get_grades",
      "pronote_get_homework",
      "pronote_get_timetable",
      "pronote_list_attachments",
      "pronote_list_homework",
      "pronote_list_periods",
      "pronote_read_attachment",
    ]);
    for (const tool of tools.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it("retourne devoirs, détail et documents sans URL interne", async () => {
    const listed = await client.callTool({ name: "pronote_list_homework", arguments: { from: "2026-09-07", to: "2026-09-12" } });
    const homework = dataOf(listed) as Array<{ id: string; documents: Array<{ id: string }> }>;
    expect(homework).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("fake://");
    const detail = await client.callTool({ name: "pronote_get_homework", arguments: { homeworkId: homework[0]?.id } });
    expect((dataOf(detail) as { subject: string }).subject).toBe("Français");
    const attachments = await client.callTool({ name: "pronote_list_attachments", arguments: { parentId: homework[0]?.id } });
    expect(dataOf(attachments)).toHaveLength(1);
    const read = await client.callTool({ name: "pronote_read_attachment", arguments: { attachmentId: homework[0]?.documents[0]?.id } });
    expect((dataOf(read) as { untrustedContent: boolean }).untrustedContent).toBe(true);
  });

  it("retourne emploi du temps, périodes et notes normalisés", async () => {
    const timetable = await client.callTool({ name: "pronote_get_timetable", arguments: { from: "2026-09-07", to: "2026-09-07" } });
    const courses = dataOf(timetable) as Array<{ startsAt: string; room: string }>;
    expect(courses[0]?.startsAt).toMatch(/\+02:00$/u);
    expect(courses[0]?.room).toBe("B204");
    const periods = await client.callTool({ name: "pronote_list_periods", arguments: {} });
    const period = (dataOf(periods) as Array<{ id: string }>)[0];
    const grades = await client.callTool({ name: "pronote_get_grades", arguments: { periodId: period?.id } });
    expect((dataOf(grades) as { grades: Array<{ score: { value: number } }> }).grades[0]?.score.value).toBe(16);
  });

  it("ne divulgue aucun secret dans tous les résultats", async () => {
    const calls = [
      ["pronote_connection_status", {}],
      ["pronote_list_homework", { from: "2026-09-07", to: "2026-09-12" }],
      ["pronote_get_timetable", { from: "2026-09-07", to: "2026-09-07" }],
      ["pronote_list_periods", {}],
    ] as const;
    for (const [name, args] of calls) {
      const result = JSON.stringify(await client.callTool({ name, arguments: args }));
      expect(result).not.toMatch(/(?:token|deviceUUID|username|password|mdp|loginState|FichiersExternes|Session=)/iu);
    }
  });
});

describe("erreurs de connexion MCP", () => {
  it.each([
    [new FakePronoteConnector({ connected: false }), "NOT_CONNECTED"],
    [new FakePronoteConnector({ expired: true }), "TOKEN_EXPIRED"],
  ])("retourne une erreur sûre et actionnable", async (connector, code) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createPronoteMcpServer(new ToolController(connector));
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "pronote_list_periods", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(code);
    expect(JSON.stringify(result)).not.toMatch(/(?:deviceUUID|username|password|mdp|FichiersExternes|Session=)/iu);
    await Promise.all([client.close(), server.close()]);
  });
});
