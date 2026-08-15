/**
 * Completes an approval waitpoint from the terminal.
 *
 * Make scenario C is the real path — a human clicks a link in Slack and the
 * relay POSTs the decision. This is the same POST without the relay, so the
 * approval branch is testable before any Make scenario exists.
 *
 *   pnpm approve --token waitpoint_abc123
 *   pnpm approve --token waitpoint_abc123 --reject
 *
 * The token id is logged by the task when it parks, so it is visible in the
 * Trigger.dev run timeline.
 */
import { parseArgs } from "node:util";
import { configure, wait } from "@trigger.dev/sdk";

async function main() {
  const { values } = parseArgs({
    options: {
      token: { type: "string", short: "t" },
      reject: { type: "boolean", default: false },
    },
  });

  const token = values.token;

  if (token === undefined || token.length === 0) {
    console.error("Usage: pnpm approve --token <waitpoint id> [--reject]");
    process.exitCode = 1;
    return;
  }

  const secretKey = process.env["TRIGGER_SECRET_KEY"];
  if (!secretKey) {
    throw new Error("TRIGGER_SECRET_KEY is not set. Copy .env.example to .env.");
  }
  configure({ secretKey });

  const decision = values.reject ? "reject" : "approve";

  // Same shape the task validates with approvalDecisionSchema. A mismatch here
  // is treated as a reject by the task, which is the correct failure direction.
  await wait.completeToken(token, { decision });

  console.log(`Sent "${decision}" to ${token}.`);
  console.log("The parked run should resume within a second or two.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
