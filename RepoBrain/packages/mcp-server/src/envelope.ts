/**
 * Zod mirror of the `@repobrain/shared` MCP response envelope (spec §10.2).
 *
 * The *types* come from `@repobrain/shared` (the stable contract); the *schemas*
 * here are used as every tool's `outputSchema` and for validating tool output in
 * tests. Keeping both in one file makes the contract easy to audit.
 */
import { z } from 'zod';

export type { Envelope, EnvelopeItem } from '@repobrain/shared';

/** spec §10.2 — a single referenced node in a tool response. */
export const EnvelopeItemSchema = z.object({
  type: z.enum(['file', 'symbol', 'route', 'test', 'memory', 'package']),
  path: z.string().optional(),
  symbol: z.string().optional(),
  reason: z.string(),
  score: z.number().optional(),
  confidence: z.number().optional(),
  resolution: z.enum(['exact', 'heuristic']).optional(),
});

/** spec §0.1(5), §7.5 — freshness stamp carried on every envelope. */
export const FreshnessSchema = z.object({
  index_commit: z.string().nullable(),
  dirty: z.boolean(),
  changed_since_index: z.number(),
});

/**
 * Raw Zod shape for the envelope. The MCP SDK accepts either a raw shape or a
 * built schema; we expose both (`EnvelopeShape` for shape-based APIs and
 * `EnvelopeSchema` for `.parse`).
 */
export const EnvelopeShape = {
  summary: z.string(),
  items: z.array(EnvelopeItemSchema),
  recommended_next_files: z.array(z.string()),
  token_estimate: z.number(),
  confidence: z.number(),
  freshness: FreshnessSchema,
  next_actions: z.array(z.string()),
} as const;

export const EnvelopeSchema = z.object(EnvelopeShape);
