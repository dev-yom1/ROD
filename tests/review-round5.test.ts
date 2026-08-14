import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import { extractReadmePlan } from "../lib/analyzer/readme";
import { selectNodeSandboxRuntimes } from "../lib/analyzer/runtime";
import type { ExecutionObservation, RepoFacts } from "../lib/analyzer/types";

const BASE_FACTS: RepoFacts = {
  packageManager: "npm",
  nodePackageManager: "npm",
  pythonPackageManager: null,
  scripts: { dev: "next dev" },
  nodeRequirement: ">=22",
  pythonRequirement: null,
  nodePreferredVersion: null,
  pythonPreferredVersion: null,
  inferredInstallCommand: "npm install",
  inferredStartCommand: "npm run dev",
  inferredNodeInstallCommand: "npm install",
  inferredNodeStartCommand: "npm run dev",
  inferredPythonInstallCommand: null,
  requiredEnv: [],
  envExampleVars: [],
  envFileVars: {},
};

function run(overrides: Partial<ExecutionObservation> = {}): ExecutionObservation {
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

test("missing start exit file remains unknown so a live process can time out", () => {
  const source = readFileSync(new URL("../lib/runner/sandbox.ts", import.meta.url), "utf8");
  assert.match(source, /const raw = \(await result\.stdout\(\)\)\.trim\(\);/);
  assert.match(source, /if \(!\/\^-\?\\d\+\$\/\.test\(raw\)\) return null;/);

  const readme = "## Development\n```bash\nnpm run dev\n```";
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, BASE_FACTS, run({
    startCommand: "npm run dev",
    startupTimedOut: true,
    startExitCode: null,
  }));
  assert(findings.some((finding) => finding.code === "RUNNER_TIMEOUT"));
  assert(!findings.some((finding) => finding.code === "COMMAND_BROKEN"));
});

test("alternative installation sections select the package-manager path used by start", () => {
  const readme = `# App

## Installation with npm
\`\`\`bash
npm install
\`\`\`

## Installation with pnpm
\`\`\`bash
pnpm install
\`\`\`

## Development
\`\`\`bash
npm run dev
\`\`\`
`;
  const plan = extractReadmePlan(readme);
  assert.deepEqual(plan.commands, ["npm install", "npm run dev"]);
});

test("multiple install alternatives inside one setup section select one matching start", () => {
  const readme = `## Installation
\`\`\`bash
npm install
pnpm install
\`\`\`

## Development
\`\`\`bash
pnpm run dev
\`\`\`
`;
  const plan = extractReadmePlan(readme);
  assert.deepEqual(plan.commands, ["pnpm install", "pnpm run dev"]);
});

test("nonzero start exit is broken even when a child endpoint returns HTTP 200", () => {
  const readme = "## Development\n```bash\nnpm run dev\n```\nOpen http://localhost:3000";
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, BASE_FACTS, run({
    startCommand: "npm run dev",
    startExitCode: 1,
    startLog: "parent script failed",
    observedPort: 3000,
    observedUrl: "http://localhost:3000",
    httpStatus: 200,
  }));
  assert(findings.some((finding) => finding.code === "COMMAND_BROKEN"));
});

test("compound runtime alternatives preserve comparator grouping", () => {
  const readme = `Requires Node.js >=22 <23 or >=24 <25.

## Development
\`\`\`bash
npm install
npm run dev
\`\`\``;
  const plan = extractReadmePlan(readme);
  assert.equal(plan.nodeRequirement, ">=22 <23 || >=24 <25");
});

test("runner preflight is limited to executable preparation/install/start steps", () => {
  const readme = `## Setup
\`\`\`bash
custom-setup-tool prepare
npm install
\`\`\`
## Development
\`\`\`bash
npm run dev
\`\`\``;
  const plan = extractReadmePlan(readme);
  assert(plan.steps.some((step) => step.command === "custom-setup-tool prepare" && step.role === "other"));

  const source = readFileSync(new URL("../lib/runner/sandbox.ts", import.meta.url), "utf8");
  assert.match(source, /parsed\.safe\s*&&\s*parsed\.executable/);
  assert.match(source, /step\.role === "preparation" \|\| step\.role === "install" \|\| step\.role === "start"/);
  assert.match(source, /const commands = plannedExecutableCommands\(plan\)/);
});

test("README runtime narrows the Sandbox candidate set", () => {
  const readme = `Requires Node.js 26.

## Development
\`\`\`bash
npm install
npm run dev
\`\`\``;
  const plan = extractReadmePlan(readme);
  assert.equal(plan.nodeRequirement, "26");
  assert.deepEqual(selectNodeSandboxRuntimes(plan.nodeRequirement), ["node26"]);

  const source = readFileSync(new URL("../lib/runner/sandbox.ts", import.meta.url), "utf8");
  assert.match(source, /const readmeRuntimes = selectNodeSandboxRuntimes\(readmeRequirement\)/);
  assert.match(source, /repoRuntimes\.filter\(\(runtime\) => readmeRuntimes\.includes\(runtime\)\)/);
});

test("startup probe stops early once the start process has exited", () => {
  const source = readFileSync(new URL("../lib/runner/sandbox.ts", import.meta.url), "utf8");
  assert.match(source, /if \(await readStartExitCode\(sandbox\) !== null\) return lastServerError;/);
});
