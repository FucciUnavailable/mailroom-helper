import { defineConfig } from "@trigger.dev/sdk";

/**
 * The CLI evaluates this file through c12/jiti before it loads `.env`, and it
 * only calls the dotenv loader on `deploy`, never on `dev`. So without this
 * line `pnpm dev` throws the "not set" error below at a developer who has a
 * perfectly good `.env` sitting next to it.
 *
 * `process.loadEnvFile` is a Node builtin (>= 20.12) — no dependency, and real
 * environment variables still win over the file, so a deployed run reads its
 * values from the platform. The file is absent on Trigger.dev's build machines,
 * hence the catch.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env — expected when the environment supplies the variables directly.
}

const projectRef = process.env["TRIGGER_PROJECT_REF"];

if (!projectRef) {
  throw new Error(
    "TRIGGER_PROJECT_REF is not set. Copy .env.example to .env and fill it in.",
  );
}

export default defineConfig({
  project: projectRef,
  runtime: "node",
  logLevel: "log",
  // A run parked on wait.forToken is suspended, not billed. This ceiling only
  // covers active execution: classify, the agent loop, and two HTTP posts.
  maxDuration: 120,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 10_000,
      factor: 2,
      randomize: true,
    },
  },
});
