/**
 * CRM client. Sends leads to the external CRM system. Before a lead leaves the
 * process its phone number is normalized to E.164-ish digits so the CRM always
 * receives a consistent format.
 */

import { config } from "../../common/config.js";
import { logger } from "../../common/logger.js";
import type { Lead } from "../leads/lead.schema.js";

export interface CrmLeadPayload {
  full_name: string;
  email: string;
  phone: string | null;
  channel: string;
}

/**
 * Normalizes a raw phone string into digits with a leading country code.
 * Returns `null` when the input has no usable digits.
 *
 * Examples:
 *   "+1 (415) 555-0199" -> "14155550199"
 *   "415 555 0199"      -> "14155550199" (default country code prepended)
 */
export function normalizePhone(
  raw: string | undefined,
  countryCode: string = config.defaultCountryCode,
): string | null {
  if (!raw) {
    return null;
  }

  const hadPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) {
    return null;
  }

  if (hadPlus) {
    return digits;
  }

  if (digits.startsWith(countryCode)) {
    return digits;
  }

  return `${countryCode}${digits}`;
}

function toCrmPayload(lead: Lead): CrmLeadPayload {
  return {
    full_name: lead.name,
    email: lead.email,
    phone: normalizePhone(lead.phone),
    channel: lead.source,
  };
}

/**
 * Sends a lead to the CRM and returns the CRM-assigned identifier.
 * Throws when the CRM responds with a non-2xx status.
 */
export async function sendLeadToCrm(lead: Lead): Promise<string> {
  const payload = toCrmPayload(lead);
  const url = `${config.crm.baseUrl}/leads`;

  logger.debug("sending lead to crm", { url, leadId: lead.id });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.crm.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.crm.timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`CRM responded with status ${response.status}`);
  }

  const body = (await response.json()) as { id?: string };
  if (!body.id) {
    throw new Error("CRM response did not include an id");
  }

  return body.id;
}
