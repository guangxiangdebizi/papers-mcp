import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { searchPapersTool } from "./tools/searchPapers.js";
import { analyzePaperTool } from "./tools/analyzePaper.js";

const server = new Server({
  name: "PaperMCP",
  version: "1.0.0",
}, {
  capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: searchPapersTool.name,
        description: searchPapersTool.description,
        inputSchema: searchPapersTool.parameters,
      },
      {
        name: analyzePaperTool.name,
        description: analyzePaperTool.description,
        inputSchema: analyzePaperTool.parameters,
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case searchPapersTool.name:
      return await searchPapersTool.run(request.params.arguments as any);
    case analyzePaperTool.name:
      return await analyzePaperTool.run(request.params.arguments as any);
    default:
      throw new Error("Unknown tool");
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);