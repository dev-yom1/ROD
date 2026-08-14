import assert from "node:assert/strict";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import { extractReadmePlan } from "../lib/analyzer/readme";
import type { ExecutionObservation } from "../lib/analyzer/types";

const FACTS = {
  packageManager: "npm" as const,
  scripts: { dev: "next dev" },
  nodeRequirement: null,
  pythonRequirement: null,
  inferredInstallCommand: "npm ci",
  inferredStartCommand: "npm run dev",
  requiredEnv: [],
  envExampleVars: [],
};

function run(overrides: Partial<ExecutionObservation>): ExecutionObservation {
  return {
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
    ...overrides,
  };
}

test("install after start remains visibly unreproduced", () => {
  const readme = `# App\n\n\`\`\`bash\nnpm run dev\nnpm ci\n\`\`\``;
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, FACTS, run({
    startCommand: "npm run dev",
    observedPort: 3000,
    observedUrl: "http://localhost:3000",
    httpStatus: 200,
  }));

  assert(findings.some((finding) => (
    finding.code === "RUNNER_COMMAND_UNSUPPORTED" && finding.detail.includes("npm ci")
  )));
});

test("preparation after install is not counted as reproduced when runner omits it", () => {
  const readme = `# App\n\n\`\`\`bash\nnpm ci\nmkdir generated\nnpm run dev\n\`\`\``;
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, FACTS, run({
    install: { command: "npm ci", exitCode: 0, stdout: "", stderr: "", timedOut: false },
    startCommand: "npm run dev",
    observedPort: 3000,
    observedUrl: "http://localhost:3000",
    httpStatus: 200,
  }));

  assert(findings.some((finding) => (
    finding.code === "RUNNER_COMMAND_UNSUPPORTED" && finding.detail.includes("mkdir generated")
  )));
});
