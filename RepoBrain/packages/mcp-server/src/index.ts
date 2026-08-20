/**
 * @repobrain/mcp-server — exposes RepoBrain over the Model Context Protocol
 * (spec §10). Registers all 13 tools, each returning the unified envelope
 * (spec §10.2), and speaks over stdio.
 *
 * The SDK surface is isolated in a single `defineTool` helper so a future SDK
 * migration is a one-file change. Tool logic lives in `./handlers.ts` as pure,
 * unit-testable functions.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RepoBrain, NotIndexedError } from '@repobrain/core';
import { z } from 'zod';
import { EnvelopeSchema } from './envelope.js';
import type { Envelope } from './envelope.js';
import * as h from './handlers.js';

export * from './handlers.js';
export {
  EnvelopeSchema,
  EnvelopeItemSchema,
  FreshnessSchema,
  EnvelopeShape,
} from './envelope.js';
export type { Envelope, EnvelopeItem } from './envelope.js';

// ─────────────────────────────────────────────────────────────────
// SDK isolation: one place that touches `server.registerTool`
// ─────────────────────────────────────────────────────────────────

type ShapeInput<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

interface ToolConfig<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  /** Runs the tool; may return extra text blocks (e.g. the capsule markdown). */
  run: (args: ShapeInput<Shape>) => Promise<{ envelope: Envelope; extraText?: string[] }>;
}

/**
 * Registers a tool whose output is always the RepoBrain envelope. Every tool's
 * `outputSchema` is the shared `EnvelopeSchema`; the handler emits the envelope
 * as JSON text (+ optional extra text blocks) and as `structuredContent`.
 */
function defineTool<Shape extends z.ZodRawShape>(server: McpServer, cfg: ToolConfig<Shape>): void {
  server.registerTool(
    cfg.name,
    {
      title: cfg.title,
      description: cfg.description,
      inputSchema: cfg.inputSchema,
      outputSchema: EnvelopeSchema,
    },
    (async (args: ShapeInput<Shape>) => {
      const { envelope, extraText } = await cfg.run(args);
      const content = [
        { type: 'text' as const, text: JSON.stringify(envelope, null, 2) },
        ...(extraText ?? []).map((text) => ({ type: 'text' as const, text })),
      ];
      return { content, structuredContent: envelope as unknown as Record<string, unknown> };
    }) as never,
  );
}

// ─────────────────────────────────────────────────────────────────
// Input schemas (raw Zod shapes)
// ─────────────────────────────────────────────────────────────────

const symbolKind = z.enum([
  'module',
  'function',
  'class',
  'method',
  'interface',
  'type',
  'constant',
  'variable',
  'route_handler',
  'test_case',
]);
const memoryType = z.enum([
  'architecture_decision',
  'bug_resolution',
  'project_convention',
  'known_issue',
  'failed_attempt',
  'agent_note',
]);

// ─────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────

type GetBrain = () => Promise<RepoBrain>;

/**
 * Wraps a pure handler so that a missing index yields an error envelope rather
 * than a thrown MCP error (spec §7.5). Other errors propagate to the SDK.
 */
function guarded<In>(
  getBrain: GetBrain,
  fn: (brain: RepoBrain, args: In) => Envelope | Promise<Envelope>,
): (args: In) => Promise<{ envelope: Envelope; extraText?: string[] }> {
  return async (args) => {
    try {
      const brain = await getBrain();
      return { envelope: await fn(brain, args) };
    } catch (e) {
      if (e instanceof NotIndexedError) return { envelope: h.notIndexedEnvelope(e.message) };
      throw e;
    }
  };
}

/** Registers all 13 RepoBrain tools on the given server. Exported for testing/embedding. */
export function registerTools(server: McpServer, getBrain: GetBrain): void {
  defineTool(server, {
    name: 'search_code',
    title: 'Search code',
    description:
      'Graph + lexical code search over the deterministic code graph (semantic vectors optional). ' +
      'Pass the ENGLISH identifiers/terms a developer would have used (translate the task if needed — ' +
      'code is English). Returns ranked symbols with a "why" reason. Use this instead of grep.',
    inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
    run: guarded(getBrain, h.searchCode),
  });

  defineTool(server, {
    name: 'find_symbol',
    title: 'Find symbol',
    description: 'Look up symbols by exact name, optionally filtered by kind.',
    inputSchema: { name: z.string(), kind: symbolKind.optional() },
    run: guarded(getBrain, h.findSymbol),
  });

  defineTool(server, {
    name: 'find_references',
    title: 'Find references',
    description: 'Heuristic references to a symbol (call-graph based). Items carry per-edge confidence.',
    inputSchema: { target: z.string() },
    run: guarded(getBrain, h.findReferences),
  });

  defineTool(server, {
    name: 'get_file_overview',
    title: 'File overview',
    description: 'Symbols, imports and importers for a repo-relative file path.',
    inputSchema: { path: z.string() },
    run: guarded(getBrain, h.getFileOverview),
  });

  defineTool(server, {
    name: 'get_callers',
    title: 'Get callers',
    description: 'Heuristic callers of a symbol (who calls it).',
    inputSchema: { target: z.string() },
    run: guarded(getBrain, h.getCallers),
  });

  defineTool(server, {
    name: 'get_callees',
    title: 'Get callees',
    description: 'Heuristic callees of a symbol (what it calls).',
    inputSchema: { target: z.string() },
    run: guarded(getBrain, h.getCallees),
  });

  defineTool(server, {
    name: 'get_routes',
    title: 'Get routes',
    description: 'HTTP routes, optionally filtered by method or path substring.',
    inputSchema: { filter: z.string().optional() },
    run: guarded(getBrain, h.getRoutes),
  });

  defineTool(server, {
    name: 'get_impact',
    title: 'Get impact',
    description: 'Blast radius of a symbol: importers, tests, and callers.',
    inputSchema: { target: z.string() },
    run: guarded(getBrain, h.getImpact),
  });

  defineTool(server, {
    name: 'make_context_capsule',
    title: 'Make context capsule',
    description:
      'Build a task-scoped Context Capsule from the code graph. Returns the envelope plus the full ' +
      'rendered markdown as a second text block. Tip: include the ENGLISH keywords you extracted from ' +
      'the task (identifiers a developer would use) so the graph search lands precisely.',
    inputSchema: {
      task: z.string(),
      token_budget: z.number().int().positive().optional(),
      model: z.string().optional(),
      package: z.string().optional(),
    },
    run: async (args) => {
      try {
        const brain = await getBrain();
        const { envelope, markdown } = await h.makeContextCapsuleFull(brain, args);
        return { envelope, extraText: [markdown] };
      } catch (e) {
        if (e instanceof NotIndexedError) return { envelope: h.notIndexedEnvelope(e.message) };
        throw e;
      }
    },
  });

  defineTool(server, {
    name: 'get_architecture_summary',
    title: 'Architecture summary',
    description: 'High-level map: counts, languages, top modules, entry points and god-files.',
    inputSchema: {},
    run: guarded(getBrain, (brain) => h.getArchitectureSummary(brain)),
  });

  defineTool(server, {
    name: 'remember_decision',
    title: 'Remember decision',
    description: 'Persist a team-memory note (decision, convention, known issue, failed attempt).',
    inputSchema: {
      note: z.string(),
      type: memoryType.optional(),
      related_files: z.array(z.string()).optional(),
    },
    run: guarded(getBrain, h.rememberDecision),
  });

  defineTool(server, {
    name: 'get_team_memory',
    title: 'Get team memory',
    description: 'Search persisted team-memory notes.',
    inputSchema: { query: z.string() },
    run: guarded(getBrain, h.getTeamMemory),
  });

  defineTool(server, {
    name: 'get_token_stats',
    title: 'Get token stats',
    description: 'ROI: tokens saved by capsules vs naive exploration (spec §14).',
    inputSchema: {},
    run: guarded(getBrain, (brain) => h.getTokenStats(brain)),
  });
}

// ─────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────

/**
 * Creates the MCP server, registers all tools, and connects over stdio.
 * The RepoBrain is opened lazily on first tool call and cached; if the repo is
 * not indexed, tools return an error envelope instead of failing the connection.
 */
export async function startMcpServer(
  opts: { root?: string; cacheDir?: string; embed?: boolean } = {},
): Promise<void> {
  const root = opts.root ?? process.cwd();

  let brain: RepoBrain | null = null;
  const getBrain: GetBrain = async () => {
    if (!brain) brain = await RepoBrain.open(root, { cacheDir: opts.cacheDir, embed: opts.embed });
    return brain;
  };

  const server = new McpServer({ name: 'repobrain', version: '0.0.0' });
  registerTools(server, getBrain);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
