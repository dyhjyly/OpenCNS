#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { supabase } from './db.js';
import { getEmbedding } from './embedding.js';
import { z } from 'zod';
import {
  SaveMemorySchema,
  SearchMemoriesSchema,
  ReadMemorySchema,
  DeleteMemorySchema,
  RunDecaySchema,
} from './tools/schemas.js';
import { analyzeMemory } from './analyzer.js';
import { handleSaveMemory } from './memory/save.js';
import { handleSearchMemories } from './memory/search.js';
import { handleReadMemory } from './memory/read.js';
import { handleDeleteMemory } from './memory/delete.js';
import { runMemoryDecay } from './memory/decayEngine.js';
import { runOpenCNS } from "./core/index.js";

// Tool definitions
const TOOLS = [
  {
    name: 'save_memory',
    description: 'Save a memory with content and optional metadata. Automatically generates vector embeddings for semantic search.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The memory content to save',
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata (tags, categories, etc.)',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memories',
    description: 'Search memories using semantic similarity. Returns memories most similar to the query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 5, max: 50)',
          default: 5,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_memory',
    description: 'Read a specific memory by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The UUID of the memory to read',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a memory by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The UUID of the memory to delete',
        },
      },
      required: ['id'],
    },
  },
  {
  name: 'run_memory_decay',
  description: 'Run memory decay engine to recompute importance scores',
  inputSchema: {
    type: 'object',
    properties: {
      batchSize: {
        type: 'number',
        default: 50,
      },
    },
  },
 }
];


// Create MCP server
function createMcpServer() {
const server = new Server(
  {
    name: 'mcp-memory-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'save_memory':
        return await handleSaveMemory(args);
      case 'search_memories':
        return await handleSearchMemories(args);
      case 'read_memory':
        return await handleReadMemory(args);
      case 'delete_memory':
        return await handleDeleteMemory(args);
      case 'run_memory_decay': {
        const batchSize = (args as any)?.batchSize ?? 50;

        const result = await runMemoryDecay(batchSize);

        return {
          content: [
           {
            type: 'text',
            text: JSON.stringify(result, null, 2),
           },
        ],
       };
    }
     default:
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'Invalid arguments',
              details: (error as any).issues,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
});
return server;
}

// ============================================
// HTTP Server with StreamableHTTP Transport
// ============================================
function startHttpServer(port: number) {
  const app = express();
  app.use(express.json());

 
  // MCP StreamableHTTP endpoint - handles all MCP protocol messages
app.all('/messages', async (req, res) => {
  try {
  const server = createMcpServer(); 
   const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});  

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      server: 'mcp-memory-server',
      version: '1.0.0',
      transport: 'StreamableHTTP',
      tools: TOOLS.map(t => t.name),
    });
  });

  // List tools (REST API)
  app.get('/tools', (req, res) => {
    res.json({ tools: TOOLS });
  });

  // Call tool (REST API)
  app.post('/tools/:name', async (req, res) => {
    const { name } = req.params;
    const args = req.body;

    try {
      let result;
      switch (name) {
        case 'save_memory':
          result = await handleSaveMemory(args);
          break;
        case 'search_memories':
          result = await handleSearchMemories(args);
          break;
        case 'read_memory':
          result = await handleReadMemory(args);
          break;
        case 'delete_memory':
          result = await handleDeleteMemory(args);
          break;
        default:
          res.status(404).json({ error: `Unknown tool: ${name}` });
          return;
      }
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          error: 'Invalid arguments',
          details: error.issues,
        });
      } else {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  });

  app.listen(port, () => {
    console.error(`========================================`);
    console.error(`  MCP Memory Server started`);
    console.error(`  Port: ${port}`);
    console.error(`  Transport: StreamableHTTP`);
    console.error(`  MCP:  http://localhost:${port}/messages`);
    console.error(`  REST: http://localhost:${port}/tools`);
    console.error(`  Health: http://localhost:${port}/health`);
    console.error(`  Tools: ${TOOLS.map(t => t.name).join(', ')}`);
    console.error(`========================================`);
  });
}

// ============================================
// Main
// ============================================
async function main() {
    const result = await runOpenCNS();
     console.dir(result, { depth: null });
    
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3000;

  startHttpServer(port);
}

main().catch((error) => {
  console.error('Failed to start MCP Memory Server:', error);
  process.exit(1);
});
