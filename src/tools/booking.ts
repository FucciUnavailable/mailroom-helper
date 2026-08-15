import { tool } from "ai";
import { logger } from "@trigger.dev/sdk";
import { bookingLinkInputSchema, bookingLinkOutputSchema } from "../schemas";

/**
 * MOCKED SCHEDULING.
 *
 * Returns a static link. There is no freebusy query, no slot negotiation, and
 * no calendar write — so there is nothing here that can double-book a real
 * person during a demo.
 *
 * Real scheduling is a different shape of problem: propose slots, hold them,
 * then write only after the recipient picks one. That belongs behind the
 * approval gate as an external write, not in a static string.
 */
const BOOKING_URL = "https://cal.example.test/mailroom/30min";

export const bookingLinkTool = tool({
  description:
    "Get the scheduling link to offer when someone asks for a call, demo, or " +
    "meeting. This returns a self-serve booking page — it does not check " +
    "availability or reserve anything, so never state a specific time.",
  inputSchema: bookingLinkInputSchema,
  outputSchema: bookingLinkOutputSchema,
  execute: async ({ reason }) => {
    logger.info("booking_link", { reason: reason ?? null });

    return bookingLinkOutputSchema.parse({
      url: BOOKING_URL,
      note: "Self-serve booking page. No time has been held.",
    });
  },
});
