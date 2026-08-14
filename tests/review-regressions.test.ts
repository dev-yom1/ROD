import assert from "node:assert/strict";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import { extractReadmePlan, isSafeOnboardingCommand } from "../lib/analyzer/readme";
import type { ExecutionObservation } from "../lib/analyzer/types";

const EMPTY_RUN: ExecutionObservation = {
  preparation: [],
  unsupportedCommands: [],
  install: null,
  startCommand: null,
  startLog: "",
  observedPort: null,
  observedUrl: null,
  httpStatus: null,
  startupTimedOut: false,
  runtimeIssue: null,
};

const FACTS = {
  packageManager: "npm" as const,
  scripts: { dev: "next dev", "db:migrate": "node migrate.js" },
  nodeRequirement: null,
  pythonRequirement: null,
  inferredInstallCommand: "npm ci",
  inferredStartCommand: "npm run dev",
  requiredEnv: [],
  envExampleVars: [],
};

test("safe but unclassified README command is reported as unreproduced", () => {
  const readme = `# App\n\n\`\`\`bash\nnpm ci\nnpm run db:migrate\nnpm run dev\n\`\`\`\n\nOpen http://localhost:3000.`;
  const plan = extractReadmePlan(readme);
  const run: ExecutionObservation = {
    ...EMPTY_RUN,
    install: { command: "npm ci", exitCode: 0, stdout: "", stderr: "", timedOut: false },
    startCommand: "npm run dev",
    observedPort: 3000,
    observedUrl: "https://sandbox.example",
    httpStatus: 200,
  };

  assert.equal(isSafeOnboardingCommand("npm run db:migrate"), true);
  const findings = diagnose(readme, plan, FACTS, run);
  assert(findings.some((finding) => (
    finding.code === "RUNNER_COMMAND_UNSUPPORTED" && finding.detail.includes("npm run db:migrate")
  )));
});

test("env example only covers variables after a successful exact copy step", () => {
  const command = "cp .env.example .env";
  const readme = `# App\n\n\`\`\`bash\n${command}\nnpm ci\nnpm run dev\n\`\`\``;
  const plan = extractReadmePlan(readme);
  const facts = { ...FACTS, requiredEnv: ["DATABASE_URL"], envExampleVars: ["DATABASE_URL"] };
  const baseRun: ExecutionObservation = {
    ...EMPTY_RUN,
    install: { command: "npm ci", exitCode: 0, stdout: "", stderr: "", timedOut: false },
    startCommand: "npm run dev",
  };

  assert(diagnose(readme, plan, facts, baseRun).some((finding) => finding.code === "ENV_MISSING"));

  const successfulCopy: ExecutionObservation = {
    ...baseRun,
    preparation: [{ command, exitCode: 0, stdout: "", stderr: "", timedOut: false }],
  };
  assert(!diagnose(readme, plan, facts, successfulCopy).some((finding) => finding.code === "ENV_MISSING"));
});

test("chained env copy is neither recognized nor accepted as reproduced env setup", () => {
  const command = "cp .env.example .env && echo copied";
  const readme = `# App\n\n\`\`\`bash\n${command}\nnpm ci\nnpm run dev\n\`\`\``;
  const plan = extractReadmePlan(readme);
  const facts = { ...FACTS, requiredEnv: ["DATABASE_URL"], envExampleVars: ["DATABASE_URL"] };
  const run: ExecutionObservation = {
    ...EMPTY_RUN,
    install: { command: "npm ci", exitCode: 0, stdout: "", stderr: "", timedOut: false },
    startCommand: "npm run dev",
  };
  const findings = diagnose(readme, plan, facts, run);

  assert.equal(plan.copiesEnvExample, false);
  assert(findings.some((finding) => finding.code === "ENV_MISSING"));
  assert(findings.some((finding) => (
    finding.code === "RUNNER_COMMAND_UNSUPPORTED" && finding.detail.includes(command)
  )));
});
