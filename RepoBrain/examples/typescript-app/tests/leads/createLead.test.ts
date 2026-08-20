import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLead } from "../../src/modules/leads/createLead.js";
import * as crmClient from "../../src/modules/crm/crm-client.js";
import type { LeadInput } from "../../src/modules/leads/lead.schema.js";

describe("createLead", () => {
  beforeEach(() => {
    vi.spyOn(crmClient, "sendLeadToCrm").mockResolvedValue("crm_123");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a lead and forwards it to the CRM", async () => {
    const input: LeadInput = {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+1 (415) 555-0199",
      source: "web",
    };

    const lead = await createLead(input);

    expect(lead.id).toMatch(/^lead_/);
    expect(lead.email).toBe("ada@example.com");
    expect(lead.status).toBe("sent_to_crm");
    expect(lead.crmId).toBe("crm_123");
    expect(crmClient.sendLeadToCrm).toHaveBeenCalledOnce();
  });

  it("rejects a payload without a valid email", async () => {
    const input = {
      name: "No Email",
      email: "not-an-email",
    } as LeadInput;

    await expect(createLead(input)).rejects.toThrow(/email/);
  });
});
