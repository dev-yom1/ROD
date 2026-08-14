import assert from "node:assert/strict";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import { parseEnvScanOutput } from "../lib/analyzer/env-scan";
import {
  extractReadmePlan,
  parseOnboardingCommand,
  readmeRuntimeKind,
} from "../lib/analyzer/readme";
import { buildRepoFacts } from "../lib/analyzer/repo-facts";
import { selectNodeSandboxRuntimes } from "../lib/analyzer/runtime";
import type { ExecutionObservation, RepoFacts } from "../lib/analyzer/types";
import { hasNewListener } from "../lib/runner/sandbox";

const BASE_FACTS: RepoFacts = {
  packageManager: "npm",
  scripts: { dev: "next dev" },
  nodeRequirement: null,
  pythonRequirement: null,
  inferredInstallCommand: "npm install",
  inferredStartCommand: "npm run dev",
  inferredNodeInstallCommand: "npm install",
  inferredNodeStartCommand: "npm run dev",
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
    runnerIssue: null,
    ...overrides,
  };
}

test("joins Installation and Environment setup sections into the Development flow", () => {
  const plan = extractReadmePlan(`# App

## Installation

\`\`\`bash
npm install
\`\`\`

## Environment

\`\`\`bash
cp .env.example .env.local
\`\`\`

## Development

\`\`\`bash
npm run dev
\`\`\`

Open http://localhost:3000.

## Tests

\`\`\`bash
npm test
\`\`\`
`);

  assert.deepEqual(plan.commands, [
    "npm install",
    "cp .env.example .env.local",
    "npm run dev",
  ]);
  assert.equal(plan.installCommand, "npm install");
  assert.equal(plan.startCommand, "npm run dev");
  assert.equal(plan.expectedPort, 3000);
  assert(!plan.commands.includes("npm test"));
});

test("command grammar keeps classification, safety, runtime, and ports aligned", () => {
  const cases = [
    ["python3 -m pip install -r requirements.txt", "install", "python"],
    ["python app.py", "start", "python"],
    ["uv run uvicorn app:app", "start", "python"],
    ["pnpx vite", "start", "node"],
    ["PORT=4000 npm run dev", "start", "node"],
  ] as const;

  for (const [command, role, runtime] of cases) {
    const parsed = parseOnboardingCommand(command);
    assert.equal(parsed.role, role, command);
    assert.equal(parsed.runtime, runtime, command);
    assert.equal(parsed.safe, true, command);
    assert.equal(parsed.executable, true, command);
  }
  assert.deepEqual(parseOnboardingCommand("PORT=4000 npm run dev").portHints, [4000]);
});

test("mixed Node and Python repository follows the selected Python README flow", () => {
  const plan = extractReadmePlan(`## Installation
\`\`\`bash
uv sync
\`\`\`
## Development
\`\`\`bash
uvicorn app:app
\`\`\``);
  const facts = buildRepoFacts({
    packageJson: JSON.stringify({ engines: { node: ">=22" }, scripts: { dev: "next dev" } }),
    pyproject: `[project]\nrequires-python = ">=3.13"\n[tool.uv]\n`,
    nvmrc: null,
    nodeVersion: null,
    pythonVersion: null,
    lockfiles: ["package-lock.json", "uv.lock"],
    envExample: null,
    envSample: null,
  });

  assert.equal(facts.nodePackageManager, "npm");
  assert.equal(facts.pythonPackageManager, "uv");
  assert.equal(readmeRuntimeKind(plan), "python");
  assert.equal(facts.inferredPythonInstallCommand, "uv sync");
});

test("env coverage follows the env template source that was actually copied", () => {
  const readme = `## Environment
\`\`\`bash
cp .env.sample .env
\`\`\`
## Development
\`\`\`bash
npm run dev
\`\`\``;
  const plan = extractReadmePlan(readme);
  const copyStep = plan.steps.find((step) => step.command.startsWith("cp "))!;
  const startStep = plan.steps.find((step) => step.role === "start")!;
  const copyObservation = { command: copyStep.command, exitCode: 0, stdout: "", stderr: "", timedOut: false };
  const facts: RepoFacts = {
    ...BASE_FACTS,
    requiredEnv: ["DATABASE_URL"],
    envExampleVars: ["DATABASE_URL"],
    envFileVars: {
      ".env.example": ["DATABASE_URL"],
      ".env.sample": [],
    },
  };
  const findings = diagnose(readme, plan, facts, emptyRun({
    preparation: [copyObservation],
    startCommand: "npm run dev",
    stepResults: [
      { stepId: copyStep.id, status: "executed", observation: copyObservation },
      { stepId: startStep.id, status: "executed" },
    ],
    observedPort: 3000,
    observedUrl: "http://localhost:3000",
    httpStatus: 200,
  }));

  assert(findings.some((finding) => finding.code === "ENV_MISSING"));
});

test("README env documentation uses token boundaries instead of substring matches", () => {
  const readme = `# App\n\nSUPPORT=true\n\n## Development\n\`\`\`bash\nnpm run dev\n\`\`\``;
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, { ...BASE_FACTS, requiredEnv: ["PORT"] }, emptyRun({
    startCommand: "npm run dev",
  }));
  assert(findings.some((finding) => finding.code === "ENV_MISSING"));
});

test("Python env scanner recognizes os.environ bracket access", () => {
  assert.deepEqual(parseEnvScanOutput(`app.py:1:value = os.environ["SECRET"]`), ["SECRET"]);
});

test("dangling shell continuation stays malformed instead of being repaired", () => {
  const plan = extractReadmePlan(`## Installation\n\n\`\`\`bash\nnpm install \\\n\`\`\``);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].malformed, true);
  assert.match(plan.steps[0].command, /\\$/);

  const findings = diagnose("", plan, BASE_FACTS, emptyRun({
    stepResults: [{ stepId: plan.steps[0].id, status: "skipped", reason: "malformed" }],
  }));
  assert(findings.some((finding) => (
    finding.code === "RUNNER_COMMAND_UNSUPPORTED" && finding.title.includes("incomplete")
  )));
});

test("preferred runtime version does not narrow the repository supported range", () => {
  const facts = buildRepoFacts({
    packageJson: JSON.stringify({ engines: { node: ">=22" }, scripts: { dev: "next dev" } }),
    pyproject: null,
    nvmrc: "22",
    nodeVersion: null,
    pythonVersion: null,
    lockfiles: ["package-lock.json"],
    envExample: null,
    envSample: null,
  });
  const readme = `Requires Node.js >=22.\n\n## Development\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\``;
  const findings = diagnose(readme, extractReadmePlan(readme), facts, emptyRun());

  assert.equal(facts.nodeRequirement, ">=22");
  assert.equal(facts.nodePreferredVersion, "22");
  assert(!findings.some((finding) => finding.code === "RUNTIME_MISMATCH"));
});

test("README Node 22 or 24 is a union and mismatches a Node-22-only repository", () => {
  const facts = buildRepoFacts({
    packageJson: JSON.stringify({ engines: { node: "22.x" }, scripts: { dev: "next dev" } }),
    pyproject: null,
    nvmrc: null,
    nodeVersion: null,
    pythonVersion: null,
    lockfiles: ["package-lock.json"],
    envExample: null,
    envSample: null,
  });
  const readme = `Requires Node.js 22 or 24.\n\n## Development\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\``;
  const plan = extractReadmePlan(readme);
  assert.equal(plan.nodeRequirement, "22 || 24");
  assert(diagnose(readme, plan, facts, emptyRun()).some((finding) => finding.code === "RUNTIME_MISMATCH"));
});

test("bare shell fences remain valid onboarding command sources", () => {
  const plan = extractReadmePlan(`## Development\n\n\`\`\`\nnpm install\nnpm run dev\n\`\`\``);
  assert.deepEqual(plan.commands, ["npm install", "npm run dev"]);
});

test("URL extraction stops before later debugging subsections", () => {
  const plan = extractReadmePlan(`## Development
\`\`\`bash
npm install
npm run dev
\`\`\`
Open http://localhost:3000.
### Debugging
Attach to http://localhost:9229.
`);
  assert.equal(plan.expectedPort, 3000);
  assert.equal(plan.expectedUrl, "http://localhost:3000");
});

test("missing runner tooling is a runner limitation rather than install failure", () => {
  const readme = `## Installation\n\`\`\`bash\nuv sync\n\`\`\`\n## Development\n\`\`\`bash\nuvicorn app:app\n\`\`\``;
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, {
    ...BASE_FACTS,
    packageManager: "uv",
    pythonPackageManager: "uv",
    inferredInstallCommand: "uv sync",
    inferredPythonInstallCommand: "uv sync",
    inferredStartCommand: null,
  }, emptyRun({ runnerIssue: "uv is unavailable in this Sandbox" }));

  assert(findings.some((finding) => finding.code === "RUNNER_TOOL_UNSUPPORTED"));
  assert(!findings.some((finding) => finding.code === "INSTALL_BROKEN"));
  assert(!findings.some((finding) => finding.code === "COMMAND_BROKEN"));
});

test("pre-existing expected port does not hide a start process failure", () => {
  const readme = `## Development\n\`\`\`bash\nnpm run dev\n\`\`\`\nOpen http://localhost:3000.`;
  const plan = extractReadmePlan(readme);
  const findings = diagnose(readme, plan, BASE_FACTS, emptyRun({
    startCommand: "npm run dev",
    startLog: "EADDRINUSE",
    preexistingPorts: [3000],
    startExitCode: 1,
  }));

  assert(findings.some((finding) => finding.code === "RUNNER_PREEXISTING_LISTENER"));
  assert(findings.some((finding) => finding.code === "COMMAND_BROKEN"));
});

test("listener identity distinguishes an old socket from a rebound socket on the same port", () => {
  const baseline = new Map([[3000, new Set(["inode-old"])]]);
  const unchanged = new Map([[3000, new Set(["inode-old"])]]);
  const rebound = new Map([[3000, new Set(["inode-new"])]]);

  assert.equal(hasNewListener(3000, unchanged, baseline), false);
  assert.equal(hasNewListener(3000, rebound, baseline), true);
});

test("Node runtime chooser retains later compatible majors as fallbacks", () => {
  assert.deepEqual(selectNodeSandboxRuntimes("=22.0.0 || 24.x"), ["node22", "node24"]);
});
