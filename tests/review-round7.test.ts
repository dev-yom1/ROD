import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import { extractReadmePlan } from "../lib/analyzer/readme";
import type { ExecutionObservation, RepoFacts } from "../lib/analyzer/types";

const BASE_FACTS: RepoFacts = {
  packageManager: "npm",
  nodePackageManager: "npm",
  pythonPackageManager: null,
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
  envFileVars: {},
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
    runnerIssue: null,
    preexistingPorts: [],
    startExitCode: null,
    ...overrides,
  };
}

test("multiple start fences in one terminal H2 are ambiguous, including H3 variants", () => {
  const readme = `## Development

### npm
\`\`\`bash
npm run dev
\`\`\`

### pnpm
\`\`\`bash
pnpm run dev
\`\`\`
`;
  const plan = extractReadmePlan(readme);
  assert.match(plan.flowIssue ?? "", /multiple README shell fences/i);
  const findings = diagnose(readme, plan, BASE_FACTS, emptyRun());
  assert(findings.some((finding) => finding.code === "FLOW_AMBIGUOUS"));
});

test("a Python flow never falls back to inferred Node installation", () => {
  const readme = `## Development
\`\`\`bash
python app.py
\`\`\`
`;
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, BASE_FACTS, emptyRun());
  assert(!findings.some((finding) => finding.code === "INSTALL_STEP_MISSING"));

  const source = readFileSync(new URL("../lib/runner/sandbox.ts", import.meta.url), "utf8");
  assert.match(source, /kind === "python"\) return facts\.inferredPythonInstallCommand \?\? null/);
  assert.match(source, /kind === "node"\) return facts\.inferredNodeInstallCommand \?\? null/);
});

test("environment documentation is scoped to the selected local onboarding flow", () => {
  const readme = `## Development
\`\`\`bash
npm install
npm run dev
\`\`\`
Open http://localhost:3000.

## Production deployment
Set DATABASE_URL in the hosting provider.
`;
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, { ...BASE_FACTS, requiredEnv: ["DATABASE_URL"] }, emptyRun());
  assert(!plan.flowText?.includes("Production deployment"));
  assert(findings.some((finding) => finding.code === "ENV_MISSING"));
});

test("application URL comes from terminal start prose rather than setup services", () => {
  const readme = `## Installation
Start the local emulator at http://localhost:8080.
\`\`\`bash
npm install
\`\`\`

## Development
\`\`\`bash
npm run dev
\`\`\`
Open http://localhost:3000.
`;
  const plan = extractReadmePlan(readme);
  assert.equal(plan.expectedUrl, "http://localhost:3000");
  assert.equal(plan.expectedPort, 3000);
  assert(plan.flowText?.includes("http://localhost:8080"));
  assert(!plan.terminalText?.includes("http://localhost:8080"));
});

test("successful HTTP probing waits through a start-process stability window", () => {
  const source = readFileSync(new URL("../lib/runner/sandbox.ts", import.meta.url), "utf8");
  assert.match(source, /const START_STABILITY_MS = 3_000/);
  assert.match(source, /async function stabilizeSuccessfulStart/);
  assert.match(source, /probe\?\.status && probe\.status < 500[\s\S]*await stabilizeSuccessfulStart\(sandbox\)/);
  assert.match(source, /while \(Date\.now\(\) < deadline\)[\s\S]*readStartExitCode\(sandbox\)/);
});
