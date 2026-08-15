import { z } from "zod";

/**
 * Parsed once, at import time, so a missing variable fails the process at boot
 * rather than halfway through handling a customer email.
 */
const envSchema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),

  MAKE_OUTBOUND_WEBHOOK_URL: z.url(),
  APPROVAL_RELAY_BASE_URL: z.url(),
  SLACK_WEBHOOK_URL: z.url(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const missing = parsed.error.issues
    .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(
    `Invalid environment configuration:\n${missing}\n\n` +
      "Copy .env.example to .env and fill in the values.",
  );
}

export const env = parsed.data;
