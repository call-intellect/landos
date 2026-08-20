/**
 * Lead data shapes. `LeadInput` is the untrusted payload that arrives from the
 * public API; `Lead` is the persisted, normalized record.
 */

import { z } from "zod";

export type LeadSource = "web" | "phone" | "partner" | "import";

export type LeadStatus = "new" | "sent_to_crm" | "failed";

/**
 * Raw payload accepted by `POST /leads`. Everything here is optional-ish and
 * must be validated before use.
 */
export interface LeadInput {
  name: string;
  email: string;
  phone?: string;
  source?: LeadSource;
  comment?: string;
}

/**
 * Persisted lead. Includes fields the server assigns.
 */
export interface Lead {
  id: string;
  name: string;
  email: string;
  phone?: string;
  source: LeadSource;
  status: LeadStatus;
  crmId?: string;
  createdAt: string;
}

/**
 * Zod schema mirroring `LeadInput`, kept for runtime parsing at the edge.
 */
export const leadInputSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  source: z.enum(["web", "phone", "partner", "import"]).optional(),
  comment: z.string().max(2000).optional(),
});
