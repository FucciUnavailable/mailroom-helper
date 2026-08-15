import { defineConfig } from "@trigger.dev/sdk";

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
