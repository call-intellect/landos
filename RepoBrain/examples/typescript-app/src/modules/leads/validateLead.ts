/**
 * Domain-level validation for incoming lead payloads. Builds on the shared
 * primitive validators in common/validation.
 */

import {
  IssueCollector,
  isEmail,
  isNonEmptyString,
  isPhoneLike,
} from "../../common/validation.js";
import type { LeadInput } from "./lead.schema.js";

/**
 * Validates a raw lead payload and returns a typed `LeadInput` or throws a
 * ValidationError describing every problem found.
 */
export function validateLeadPayload(payload: unknown): LeadInput {
  const collector = new IssueCollector();
  const data = (payload ?? {}) as Record<string, unknown>;

  collector.require(isNonEmptyString(data.name), "name is required");
  collector.require(isEmail(data.email), "email must be a valid address");

  if (data.phone !== undefined) {
    collector.require(
      isPhoneLike(data.phone),
      "phone must contain 7 to 15 digits",
    );
  }

  collector.throwIfAny();

  return {
    name: (data.name as string).trim(),
    email: (data.email as string).trim().toLowerCase(),
    phone: data.phone as string | undefined,
    source: data.source as LeadInput["source"],
    comment: data.comment as string | undefined,
  };
}
