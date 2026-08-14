import assert from "node:assert/strict";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import {
  extractReadmePlan,
  parseOnboardingCommand,
  readmeRuntimeKinds,
} from "../lib/analyzer/readme";
import type { ExecutionObservation, RepoFacts } from "../lib/analyzer/types";

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

const FACTS: RepoFacts = {
  packageManager: "npm",
  scripts: { dev: "next dev" },
  nodeRequirement: null,
  pythonRequirement: null,
  inferredInstallCommand: "npm install",
  inferredStartCommand: "npm run dev",
  inferredNodeInstallCommand: "npm install",
  inferredPythonInstallCommand: null,
  inferredNodeStartCommand: "npm run dev",
  requiredEnv: [],
  envExampleVars: [],
};

test("Troubleshooting start examples cannot outrank a Development flow", () => {
  const plan = extractReadmePlan(`
## Development
\`\`\`bash
npm install
npm run dev
\`\`\`
Open http://localhost:3000

## Troubleshooting
Try these only when debugging:
\`\`\`bash
npm run dev
\`\`\`
\`\`\`bash
npm start
\`\`\`
`);
  assert.equal(plan.startCommand, "npm run dev");
  assert.equal(plan.flowIssue, null);
  assert.deepEqual(plan.flowSections, ["Development"]);
});

test("mixed-runtime setup without a start still reports missing inferred Node start", () => {
  const readme = `
## Setup
\`\`\`bash
python -m pip install -r tools/requirements.txt
npm install
\`\`\`
`;
  const plan = extractReadmePlan(readme);
  assert.deepEqual(new Set(readmeRuntimeKinds(plan)), new Set(["python", "node"]));
  const findings = diagnose(readme, plan, FACTS, EMPTY_RUN);
  assert(findings.some((finding) => finding.code === "START_STEP_MISSING"));
});

test("mixed-runtime flows retain every required runtime kind", () => {
  const plan = extractReadmePlan(`
## Setup
Python 3.13 and Node.js 22 are required.
\`\`\`bash
python -m pip install -r tools/requirements.txt
npm install
\`\`\`

## Development
\`\`\`bash
npm run dev
\`\`\`
`);
  assert.deepEqual(new Set(readmeRuntimeKinds(plan)), new Set(["python", "node"]));
  assert.equal(plan.pythonRequirement, "3.13");
  assert.equal(plan.nodeRequirement, "22");
});

test("H3 package-manager install alternatives are ambiguous instead of both executing", () => {
  const plan = extractReadmePlan(`
## Installation
### npm
\`\`\`bash
npm install
\`\`\`
### pnpm
\`\`\`bash
pnpm install
\`\`\`

## Development
\`\`\`bash
npm run dev
\`\`\`
`);
  assert.match(plan.flowIssue ?? "", /multiple node installation tool families/i);
});

test("yarn install flags are not treated as package scripts for DOC_STALE", () => {
  const readme = `
## Development
\`\`\`bash
yarn --immutable
yarn dev
\`\`\`
`;
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, { ...FACTS, packageManager: "yarn" }, EMPTY_RUN);
  assert(!findings.some((finding) => finding.code === "DOC_STALE" && finding.title.includes("--immutable")));
});

test("Vite flags immediately after the wrapper still form a start command", () => {
  assert.equal(parseOnboardingCommand("npx vite --host 0.0.0.0").role, "start");
  assert.equal(parseOnboardingCommand("npx vite --port 4000").role, "start");
  assert.deepEqual(parseOnboardingCommand("npx vite --port 4000").portHints, [4000]);
});

test("application URL prefers prose after the selected start fence", () => {
  const plan = extractReadmePlan(`
## Development
Start the emulator at http://localhost:8080 first.

\`\`\`bash
npm run dev
\`\`\`

Open http://localhost:3000 in your browser.
`);
  assert.equal(plan.expectedPort, 3000);
  assert.equal(plan.expectedUrl, "http://localhost:3000");
});

test("comma-separated runtime alternatives are parsed as a union", () => {
  const plan = extractReadmePlan(`
## Development
Use Node.js 22, 24, or 26.
\`\`\`bash
npm install
npm run dev
\`\`\`
`);
  assert.equal(plan.nodeRequirement, "22 || 24 || 26");
});
