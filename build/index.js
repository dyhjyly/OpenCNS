#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const express_1 = __importDefault(require("express"));
const db_js_1 = require("./db.js");
const embedding_js_1 = require("./embedding.js");
const zod_1 = require("zod");
const analyzer_js_1 = require("./analyzer.js");
// Define tool schemas
const SaveMemorySchema = zod_1.z.object({
    content: zod_1.z.string().min(1, 'Content is required'),
    memory_type: zod_1.z.string().optional().default('fact'),
    importance: zod_1.z.number().optional().default(0.5),
    unresolved: zod_1.z.boolean().optional().default(false),
    metadata: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional().default({}),
});
const SearchMemoriesSchema = zod_1.z.object({
    query: zod_1.z.string().min(1, 'Query is required'),
    limit: zod_1.z.number().int().min(1).max(50).optional().default(5),
});
const ReadMemorySchema = zod_1.z.object({
    id: zod_1.z.string().uuid('Invalid memory ID format'),
});
const DeleteMemorySchema = zod_1.z.object({
    id: zod_1.z.string().uuid('Invalid memory ID format'),
});
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
];
// Tool handlers
async function handleSaveMemory(args) {
    const { content, metadata, } = SaveMemorySchema.parse(args);
    const analysis = await (0, analyzer_js_1.analyzeMemory)(content);
    // Generate embedding
    const embedding = await (0, embedding_js_1.getEmbedding)(content);
    // Store in Supabase
    const { data, error } = await db_js_1.supabase
        .from('memories')
        .insert({
        content,
        embedding,
        metadata,
        memory_type: analysis.memory_type,
        importance: analysis.importance,
        unresolved: analysis.unresolved,
    })
        .select('id, content, metadata, created_at')
        .single();
    if (error) {
        throw new Error(`Failed to save memory: ${error.message}`);
    }
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    message: 'Memory saved successfully',
                    memory: {
                        id: data.id,
                        content: data.content,
                        metadata: data.metadata,
                        created_at: data.created_at,
                    },
                }, null, 2),
            },
        ],
    };
}
async function handleSearchMemories(args) {
    const { query, limit } = SearchMemoriesSchema.parse(args);
    // Generate embedding for the query
    const queryEmbedding = await (0, embedding_js_1.getEmbedding)(query);
    // Search using cosine similarity via pgvector
    const { data, error } = await db_js_1.supabase.rpc('search_memories_reflex', {
        query_embedding: `[${queryEmbedding.join(',')}]`,
        match_limit: limit,
    });
    if (error) {
        throw new Error(`Failed to search memories: ${error.message}`);
    }
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    query,
                    results: data || [],
                    count: data?.length || 0,
                }, null, 2),
            },
        ],
    };
}
async function handleReadMemory(args) {
    const { id } = ReadMemorySchema.parse(args);
    const { data, error } = await db_js_1.supabase
        .from('memories')
        .select('id, content, metadata, created_at, updated_at')
        .eq('id', id)
        .single();
    if (error) {
        if (error.code === 'PGRST116') {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Memory with ID '${id}' not found`,
                        }, null, 2),
                    },
                ],
            };
        }
        throw new Error(`Failed to read memory: ${error.message}`);
    }
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    memory: data,
                }, null, 2),
            },
        ],
    };
}
async function handleDeleteMemory(args) {
    const { id } = DeleteMemorySchema.parse(args);
    // First check if memory exists
    const { data: existing, error: checkError } = await db_js_1.supabase
        .from('memories')
        .select('id')
        .eq('id', id)
        .single();
    if (checkError) {
        if (checkError.code === 'PGRST116') {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: `Memory with ID '${id}' not found`,
                        }, null, 2),
                    },
                ],
            };
        }
        throw new Error(`Failed to check memory: ${checkError.message}`);
    }
    // Delete the memory
    const { error: deleteError } = await db_js_1.supabase
        .from('memories')
        .delete()
        .eq('id', id);
    if (deleteError) {
        throw new Error(`Failed to delete memory: ${deleteError.message}`);
    }
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    message: `Memory '${id}' deleted successfully`,
                }, null, 2),
            },
        ],
    };
}
// Create MCP server
function createMcpServer() {
    const server = new index_js_1.Server({
        name: 'mcp-memory-server',
        version: '1.0.0',
    }, {
        capabilities: {
            tools: {},
        },
    });
    // Register tool handlers
    server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => ({
        tools: TOOLS,
    }));
    server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
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
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: 'Invalid arguments',
                                details: error.issues,
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
function startHttpServer(port) {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // MCP StreamableHTTP endpoint - handles all MCP protocol messages
    app.all('/messages', async (req, res) => {
        try {
            const server = createMcpServer();
            const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
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
        }
        catch (error) {
            if (error instanceof zod_1.z.ZodError) {
                res.status(400).json({
                    success: false,
                    error: 'Invalid arguments',
                    details: error.issues,
                });
            }
            else {
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
    const args = process.argv.slice(2);
    const portIndex = args.indexOf('--port');
    const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 3000;
    startHttpServer(port);
}
main().catch((error) => {
    console.error('Failed to start MCP Memory Server:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map