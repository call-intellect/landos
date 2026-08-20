/**
 * Lead creation use case. Validates the input, persists the lead, and hands it
 * off to the CRM. This is the function wired to `POST /leads`.
 */

import { generateId, getRepository } from "../../common/db.js";
import { logger } from "../../common/logger.js";
import { sendLeadToCrm } from "../crm/crm-client.js";
import type { Lead, LeadInput } from "./lead.schema.js";
import { validateLeadPayload } from "./validateLead.js";

const leads = getRepository<Lead>("leads");

/**
 * Creates a lead from an untrusted payload and forwards it to the CRM.
 *
 * @param input Raw lead payload (already shaped as `LeadInput` by the caller,
 *   but re-validated here to be safe).
 */
export async function createLead(input: LeadInput): Promise<Lead> {
  const validated = validateLeadPayload(input);

  const lead: Lead = {
    id: generateId("lead"),
    name: validated.name,
    email: validated.email,
    phone: validated.phone,
    source: validated.source ?? "web",
    status: "new",
    createdAt: new Date().toISOString(),
  };

  await leads.insert(lead);
  logger.info("lead created", { leadId: lead.id, source: lead.source });

  try {
    const crmId = await sendLeadToCrm(lead);
    lead.crmId = crmId;
    lead.status = "sent_to_crm";
    await leads.insert(lead);
    logger.info("lead synced to crm", { leadId: lead.id, crmId });
  } catch (error) {
    lead.status = "failed";
    await leads.insert(lead);
    logger.error("lead crm sync failed", {
      leadId: lead.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return lead;
}
