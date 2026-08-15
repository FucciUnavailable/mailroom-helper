/**
 * Triggers the inbound-email task directly, with Make out of the loop.
 *
 * This is the demo path and the fastest way to exercise the system from a
 * clean clone — no mailbox, no Make account, no waiting for a poll interval.
 *
 *   pnpm sample --fixture spam
 *   pnpm sample --fixture account-question
 *   pnpm sample --fixture general-question
 *
 * Add --fresh to rewrite the Message-ID, so the same fixture can be replayed
 * without tripping the idempotency guard.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { configure, tasks } from "@trigger.dev/sdk";
import { inboundEmailPayloadSchema } from "../src/schemas";
import type { inboundEmail } from "../src/trigger/inbound-email";

const FIXTURES = ["spam", "account-question", "general-question"] as const;
type Fixture = (typeof FIXTURES)[number];

function isFixture(value: string): value is Fixture {
  return (FIXTURES as readonly string[]).includes(value);
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixture: { type: "string", short: "f" },
      fresh: { type: "boolean", default: false },
    },
  });

  const name = values.fixture;

  if (name === undefined || !isFixture(name)) {
    console.error(
      `Usage: pnpm sample --fixture <${FIXTURES.join("|")}> [--fresh]`,
    );
    process.exitCode = 1;
    return;
  }

  const secretKey = process.env["TRIGGER_SECRET_KEY"];
  if (!secretKey) {
    throw new Error("TRIGGER_SECRET_KEY is not set. Copy .env.example to .env.");
  }
  configure({ secretKey });

  const here = dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(join(here, "fixtures", `${name}.json`), "utf8");

  // The fixture is a boundary like any other, so it goes through the same
  // schema the webhook does. A malformed fixture fails here, not mid-run.
  const payload = inboundEmailPayloadSchema.parse(JSON.parse(raw));

  if (values.fresh) {
    const stamp = Date.now();
    payload.messageId = `<demo-${name}-${stamp}@example-corp.test>`;
    payload.threadKey = `demo-${name}-${stamp}`;
  }

  // The Message-ID is the idempotency key. Re-running the same fixture without
  // --fresh is deduplicated by Trigger.dev before the task even starts, which
  // is itself worth showing on the demo.
  const handle = await tasks.trigger<typeof inboundEmail>(
    "inbound-email",
    payload,
    { idempotencyKey: payload.messageId },
  );

  console.log(`Triggered ${name}`);
  console.log(`  run id:      ${handle.id}`);
  console.log(`  message id:  ${payload.messageId}`);
  console.log("\nWatch it at https://cloud.trigger.dev (or your dev terminal).");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
