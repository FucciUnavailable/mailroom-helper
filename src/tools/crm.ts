import { tool } from "ai";
import { logger } from "@trigger.dev/sdk";
import { supabase } from "../lib/supabase";
import {
  crmLookupInputSchema,
  crmLookupOutputSchema,
  type CrmLookupOutput,
} from "../schemas";

/**
 * MOCKED CRM.
 *
 * This is a Supabase `contacts` table standing in for HubSpot. It is the only
 * file that knows that. Swapping to a real CRM means reimplementing
 * `lookupContact` against their API and leaving everything else — the tool
 * definition, the schemas, the task, the risk rules — untouched.
 *
 * The seam is the return shape, not the transport: `{ found, contact }` with
 * an explicit `found: false` is what the model is trained by the prompt to
 * report honestly.
 */

interface ContactRow {
  email: string;
  full_name: string;
  company: string | null;
  lifecycle_stage: string;
  notes: string | null;
}

export async function lookupContact(email: string): Promise<CrmLookupOutput> {
  const { data, error } = await supabase
    .from("contacts")
    .select("email, full_name, company, lifecycle_stage, notes")
    .eq("email", email.toLowerCase())
    .maybeSingle<ContactRow>();

  if (error) {
    throw new Error(`crm_lookup failed: ${error.message}`);
  }

  logger.info("crm_lookup", { email, found: data !== null });

  if (!data) {
    return crmLookupOutputSchema.parse({ found: false, contact: null });
  }

  return crmLookupOutputSchema.parse({
    found: true,
    contact: {
      email: data.email,
      fullName: data.full_name,
      company: data.company,
      lifecycleStage: data.lifecycle_stage,
      notes: data.notes,
    },
  });
}

export const crmLookupTool = tool({
  description:
    "Look up a contact record by exact email address. Returns their name, " +
    "company, lifecycle stage, and internal notes. If found is false, we have " +
    "no record of this person — say that plainly and never guess at their " +
    "plan, account status, or history.",
  inputSchema: crmLookupInputSchema,
  outputSchema: crmLookupOutputSchema,
  execute: async ({ email }) => lookupContact(email),
});
