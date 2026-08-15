import { createClient } from "@supabase/supabase-js";
import { env } from "../env";

/**
 * Service-role client. Every table has RLS enabled with no policies, so this
 * key is the only way in — and it never leaves the Trigger.dev task.
 *
 * No generated types: the schema is four tables and generating them would mean
 * a codegen step in CI for a repo that a reviewer reads in six minutes. Row
 * shapes are asserted at the boundary in src/schemas.ts instead.
 */
export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-application-name": "mailroom" } },
  },
);
