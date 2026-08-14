import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import { parseEnvScanOutput } from "../lib/analyzer/env-scan";
import { extractReadmePlan, parseOnboardingCommand } from "../lib/analyzer/readme";
import type { ExecutionObservation, RepoFacts } from "../lib/analyzer/types";

const FACTS: RepoFacts = {
  packageManager: "npm",
  nodePackageManager: "npm",
  pythonPackageManager: null,
  scripts: { dev: "next dev" },
  nodeRequirement: ">=22",
  pythonRequirement: null,
  inferredInstallCommand: "npm install",
  inferredStartCommand: "npm run dev",
  requiredEnv: [],
  envExampleVars: [],
  nodePreferredVersion: null,
  pythonPreferredVersion: null,
  inferredNodeInstallCommand: "npm install",
  inferredPythonInstallCommand: null,
  inferredNodeStartCommand: "npm run dev",
  envFileVars: {},
};

function command(command: string, exitCode = 0) {
  return { command, exitCode, stdout: "", stderr: "", timedOut: false };
}

function execution(overrides: Partial<ExecutionObservation> = {}): ExecutionObservation {
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
    runnerIssue: null,
    startExitCode: null,
    preexistingPorts: [],
    ...overrides,
  };
}

test("Yarn start commands are not misclassified as installs", () => {
  assert.equal(parseOnboardingCommand("yarn dev").role, "start");
  assert.equal(parseOnboardingCommand("yarn run dev").role, "start");
  assert.equal(parseOnboardingCommand("yarn start").role, "start");
  assert.equal(parseOnboardingCommand("yarn test").role, "other");
  assert.equal(parseOnboardingCommand("yarn").role, "install");
  assert.equal(parseOnboardingCommand("yarn install --immutable").role, "install");
  assert.equal(parseOnboardingCommand("yarn --frozen-lockfile").role, "install");
});

test("Next and Vite build commands are not treated as detached starts", () => {
  assert.equal(parseOnboardingCommand("npx next build").role, "other");
  assert.equal(parseOnboardingCommand("pnpx next build").role, "other");
  assert.equal(parseOnboardingCommand("bunx vite build").role, "other");
  assert.equal(parseOnboardingCommand("npx next start").role, "start");
  assert.equal(parseOnboardingCommand("npx next dev").role, "start");
  assert.equal(parseOnboardingCommand("npx vite").role, "start");
  assert.equal(parseOnboardingCommand("npx vite dev").role, "start");
});

test("multiple required install commands in one setup section are never silently dropped", () => {
  const readme = `## Installation
\`\`\`bash
python -m pip install -r tools/requirements.txt
npm install
\`\`\`

## Development
\`\`\`bash
npm run dev
\`\`\``;
  const plan = extractReadmePlan(readme);
  assert.deepEqual(plan.commands, [
    "python -m pip install -r tools/requirements.txt",
    "npm install",
    "npm run dev",
  ]);
  assert.equal(plan.flowIssue, null);
});

test("runtime requirements come from the selected onboarding flow, not unrelated README sections", () => {
  const readme = `## Legacy
Legacy maintenance uses Node.js 18.
\`\`\`bash
npm test
\`\`\`

## Development
Use Node.js 26.
\`\`\`bash
npm install
npm run dev
\`\`\``;
  const plan = extractReadmePlan(readme);
  assert.equal(plan.nodeRequirement, "26");
});

test("SemVer-style double-pipe runtime alternatives preserve comparator grouping", () => {
  const readme = `## Development
Use Node.js >=22 <23 || >=24 <25.
\`\`\`bash
npm install
npm run dev
\`\`\``;
  const plan = extractReadmePlan(readme);
  assert.equal(plan.nodeRequirement, ">=22 <23 || >=24 <25");
});

test("multiple start commands in one fence are ambiguous instead of producing an arbitrary path", () => {
  const readme = `## Development
\`\`\`bash
npm run dev
pnpm run dev
\`\`\``;
  const plan = extractReadmePlan(readme);
  assert.match(plan.flowIssue ?? "", /multiple start commands/i);

  const source = readFileSync(new URL("../lib/orchestrator/diagnose-pr.ts", import.meta.url), "utf8");
  assert.match(source, /plan\.flowIssue/);
  assert.match(source, /ambiguousFlowExecution\(plan\)/);
});

test("env scanning ignores tests, examples, and comment-only references", () => {
  const output = [
    "./src/app.ts:1:// TODO remove process.env.OLD_SECRET",
    "./tests/app.test.ts:2:const value = process.env.TEST_SECRET",
    "./examples/demo.ts:3:const value = process.env.DEMO_SECRET",
    "./src/app.ts:4:const value = process.env.API_KEY",
    "./src/settings.py:5:# os.environ[\"COMMENT_SECRET\"]",
    "./src/settings.py:6:value = os.environ[\"PY_SECRET\"]",
  ].join("\n");
  assert.deepEqual(parseEnvScanOutput(output), ["API_KEY", "PY_SECRET"]);
});

test("a documented localhost URL without a port reports only the missing port", () => {
  const readme = `## Development
\`\`\`bash
npm install
npm run dev
\`\`\`
Open http://localhost`;
  const plan = extractReadmePlan(readme);
  assert.equal(plan.expectedUrl, "http://localhost");
  assert.equal(plan.expectedPort, null);

  const findings = diagnose(readme, plan, FACTS, execution({
    install: command("npm install"),
    startCommand: "npm run dev",
    observedPort: 3000,
    observedUrl: "http://localhost:3000",
    httpStatus: 200,
  }));
  assert(findings.some((finding) => finding.code === "START_PORT_UNDOCUMENTED"));
  assert(!findings.some((finding) => finding.code === "START_URL_UNDOCUMENTED"));
});
