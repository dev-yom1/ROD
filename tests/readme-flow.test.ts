import assert from "node:assert/strict";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import { extractReadmePlan } from "../lib/analyzer/readme";
import type { ExecutionObservation, RepoFacts } from "../lib/analyzer/types";
import { renderReport } from "../lib/github/reporter";

const FACTS: RepoFacts = {
  packageManager: "npm",
  scripts: { dev: "next dev", test: "node --test", build: "next build" },
  nodeRequirement: null,
  pythonRequirement: null,
  inferredInstallCommand: "npm ci",
  inferredStartCommand: "npm run dev",
  requiredEnv: [],
  envExampleVars: [],
};

function emptyRun(overrides: Partial<ExecutionObservation> = {}): ExecutionObservation {
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

test("selects one onboarding section instead of treating later test/build fences as setup", () => {
  const readme = `# App

## Development

\`\`\`bash
npm install
npm run dev
\`\`\`

Open http://localhost:3000.

## Tests

\`\`\`bash
npm test
\`\`\`

## Build

\`\`\`bash
npm run build
\`\`\`
`;
  const plan = extractReadmePlan(readme);

  assert.deepEqual(plan.commands, ["npm install", "npm run dev"]);
  assert.equal(plan.steps.every((step) => step.section === "Development"), true);
  assert.equal(plan.expectedPort, 3000);
});

test("preserves duplicate command occurrences with distinct step identity", () => {
  const plan = extractReadmePlan(`## Development

\`\`\`bash
npm ci
npm run dev
npm ci
\`\`\`
`);

  assert.deepEqual(plan.commands, ["npm ci", "npm run dev", "npm ci"]);
  assert.equal(new Set(plan.steps.map((step) => step.id)).size, 3);
  assert.equal(plan.steps[0].command, plan.steps[2].command);
  assert.notEqual(plan.steps[0].id, plan.steps[2].id);

  const findings = diagnose("", plan, FACTS, emptyRun({
    stepResults: [
      { stepId: plan.steps[0].id, status: "executed", observation: { command: "npm ci", exitCode: 0, stdout: "", stderr: "", timedOut: false } },
      { stepId: plan.steps[1].id, status: "executed" },
      { stepId: plan.steps[2].id, status: "skipped", reason: "after-start" },
    ],
    install: { command: "npm ci", exitCode: 0, stdout: "", stderr: "", timedOut: false },
    startCommand: "npm run dev",
    observedPort: 3000,
    observedUrl: "http://localhost:3000",
    httpStatus: 200,
  }));

  const skipped = findings.filter((finding) => finding.code === "RUNNER_COMMAND_UNSUPPORTED");
  assert.equal(skipped.length, 1);
  assert.deepEqual(skipped[0].evidence, ["npm ci"]);
});

test("joins shell line continuations and ignores console transcripts", () => {
  const plan = extractReadmePlan(`## Development

\`\`\`console
$ npm test
added 123 packages
\`\`\`

\`\`\`bash
npm install \\
  --legacy-peer-deps
npm run dev
\`\`\`
`);

  assert.deepEqual(plan.commands, ["npm install --legacy-peer-deps", "npm run dev"]);
});

test("runtime incompatibility does not cascade into command or env reproduction warnings", () => {
  const readme = `## Development

\`\`\`bash
cp .env.example .env
npm ci
npm run dev
\`\`\`
`;
  const plan = extractReadmePlan(readme);
  const facts: RepoFacts = {
    ...FACTS,
    nodeRequirement: "20.x",
    requiredEnv: ["DATABASE_URL"],
    envExampleVars: ["DATABASE_URL"],
  };
  const run = emptyRun({
    runtimeIssue: "Repository requires Node.js 20.x, while ROD does not provide that runtime.",
    stepResults: plan.steps.map((step) => ({
      stepId: step.id,
      status: "blocked" as const,
      reason: "runtime-unsupported" as const,
    })),
  });
  const findings = diagnose(readme, plan, facts, run);

  assert(findings.some((finding) => finding.code === "RUNNER_RUNTIME_UNSUPPORTED"));
  assert(!findings.some((finding) => finding.code === "RUNNER_COMMAND_UNSUPPORTED"));
  assert(!findings.some((finding) => finding.code === "ENV_MISSING"));
  assert(!findings.some((finding) => finding.code === "PREPARATION_BROKEN"));
});

test("untrusted unsupported commands are rendered as fenced evidence, not inline Markdown", () => {
  const command = "npm run dev ` @octocat";
  const readme = `## Development\n\n\`\`\`bash\n${command}\n\`\`\``;
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, FACTS, emptyRun({
    stepResults: [{ stepId: plan.steps[0].id, status: "skipped", reason: "unsafe" }],
  }));
  const report = renderReport(findings, null, "0123456789abcdef", null);

  assert(findings.some((finding) => finding.code === "RUNNER_COMMAND_UNSUPPORTED"));
  assert.match(report, /```text\nnpm run dev ` @octocat\n```/);
  assert.doesNotMatch(report, /The README documents `npm run dev/);
});
