#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { createPronoteMcpServer } from "./mcp/server.js";

const runtime = await createRuntime(loadConfig({ superviseTunnel: false }));
const server = createPronoteMcpServer(runtime.controller);
const transport = new StdioServerTransport();
await server.connect(transport);
runtime.logger.info("MCP PronoteConnect actif sur stdio.", { adapter: runtime.config.adapter });
