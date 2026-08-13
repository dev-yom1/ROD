import assert from "node:assert/strict";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import { extractReadmePlan, isSafeOnboardingCommand } from "../lib/analyzer/readme";
import { buildRepoFacts } from "../lib/analyzer/repo-facts";
import {
  nodeReadmeRequirementFitsRepo,
  nodeRequirementsOverlap,
  pythonReadmeRequirementFitsRepo,
  pythonRequirementsOverlap,
  selectNodeSandboxRuntime,
  supportsPython313,
} from "../lib/analyzer/runtime";
import type { ExecutionObservation } from "../lib/analyzer/types";

const EMPTY_RUN: ExecutionObservation = {
  install: null,
  startCommand: null,
  startLog: "",
  observedPort: null,
  observedUrl: null,
  httpStatus: null,
  startupTimedOut: false,
  runtimeIssue: null,
};

const BASE_FACTS = {
  packageManager: "npm" as const,
  scripts: { dev: "next dev" },
  nodeRequirement: null,
  pythonRequirement: null,
  inferredInstallCommand: null,
  inferredStartCommand: "npm run dev",
  requiredEnv: [],
  envExampleVars: [],
};

test("extracts install, start and runtime range from README", () => {
  const plan = extractReadmePlan(`
# App
Requires Node.js >=22 <25.

\`\`\`bash
npm ci
npm run dev
\`\`\`

Open http://localhost:3000.
`);
  assert.equal(plan.installCommand, "npm ci");
  assert.equal(plan.startCommand, "npm run dev");
  assert.equal(plan.expectedPort, 3000);
  assert.equal(plan.nodeRequirement, ">=22 <25");
});

test("reports missing install step and runtime documentation", () => {
  const readme = `# App\n\n\`\`\`bash\nnpm run dev\n\`\`\``;
  const plan = extractReadmePlan(readme);
  const facts = buildRepoFacts({
    packageJson: JSON.stringify({ engines: { node: ">=22" }, scripts: { dev: "next dev" } }),
    pyproject: null,
    nvmrc: null,
    nodeVersion: null,
    pythonVersion: null,
    lockfiles: ["package-lock.json"],
    envExample: null,
  });
  const findings = diagnose(readme, plan, facts, EMPTY_RUN);
  assert(findings.some((finding) => finding.code === "INSTALL_STEP_MISSING"));
  assert(findings.some((finding) => finding.code === "RUNTIME_UNDOCUMENTED"));
});

test("supports root env example copies to Next.js env destinations", () => {
  for (const destination of [".env", ".env.local", ".env.development.local"]) {
    const command = `cp .env.example ${destination}`;
    const readme = `# App\n\n\`\`\`bash\n${command}\nnpm ci\n\`\`\``;
    const plan = extractReadmePlan(readme);
    const facts = buildRepoFacts({
      packageJson: JSON.stringify({ scripts: {} }),
      pyproject: null,
      nvmrc: null,
      nodeVersion: null,
      pythonVersion: null,
      lockfiles: ["package-lock.json"],
      envExample: "DATABASE_URL=\n",
      requiredEnv: ["DATABASE_URL"],
    });
    assert.equal(plan.copiesEnvExample, true);
    assert.equal(isSafeOnboardingCommand(command), true);
    assert(!diagnose(readme, plan, facts, EMPTY_RUN).some((finding) => finding.code === "ENV_MISSING"));
  }
  assert.equal(isSafeOnboardingCommand("cp .env.example ../.env"), false);
});

test("blocks shell chaining in README commands", () => {
  assert.equal(isSafeOnboardingCommand("npm run dev; echo nope"), false);
  assert.equal(isSafeOnboardingCommand("npm ci"), true);
});

test("selects only a compatible Vercel Node runtime", () => {
  assert.equal(selectNodeSandboxRuntime("20.x"), null);
  assert.equal(selectNodeSandboxRuntime("^20"), null);
  assert.equal(selectNodeSandboxRuntime(">=20 <22"), null);
  assert.equal(selectNodeSandboxRuntime("23.x"), null);
  assert.equal(selectNodeSandboxRuntime("^24"), "node24");
  assert.equal(selectNodeSandboxRuntime(">=25"), "node26");
  assert.equal(nodeRequirementsOverlap(">=22 <25", "^24"), true);
});

test("README runtime range must be a subset of repository range", () => {
  assert.equal(nodeReadmeRequirementFitsRepo(">=22", ">=20"), false);
  assert.equal(nodeReadmeRequirementFitsRepo(">=22", ">=22"), true);
  assert.equal(nodeReadmeRequirementFitsRepo(">=22", "22"), true);
  assert.equal(pythonReadmeRequirementFitsRepo(">=3.12", ">=3.10"), false);

  const nodeFacts = buildRepoFacts({
    packageJson: JSON.stringify({ engines: { node: ">=22" }, scripts: {} }),
    pyproject: null,
    nvmrc: null,
    nodeVersion: null,
    pythonVersion: null,
    lockfiles: [],
    envExample: null,
  });
  assert(diagnose("", extractReadmePlan("Requires Node.js >=20."), nodeFacts, EMPTY_RUN)
    .some((finding) => finding.code === "RUNTIME_MISMATCH"));
  assert(!diagnose("", extractReadmePlan("Requires Node.js >=22."), nodeFacts, EMPTY_RUN)
    .some((finding) => finding.code === "RUNTIME_MISMATCH"));
  assert(!diagnose("", extractReadmePlan("Requires Node.js 22."), nodeFacts, EMPTY_RUN)
    .some((finding) => finding.code === "RUNTIME_MISMATCH"));
});

test("checks Python 3.13 support using PEP 440-style ranges", () => {
  assert.equal(supportsPython313(">=3.12"), true);
  assert.equal(supportsPython313("<3.13"), false);
  assert.equal(pythonRequirementsOverlap(">=3.12", "3.10"), false);
});

test("reports Python runtime mismatch including partially overlapping ranges", () => {
  const facts = buildRepoFacts({
    packageJson: null,
    pyproject: '[project]\nrequires-python = ">=3.12"\n',
    nvmrc: null,
    nodeVersion: null,
    pythonVersion: null,
    lockfiles: [],
    envExample: null,
  });

  assert(diagnose("", extractReadmePlan("# App\n\nRequires Python 3.10."), facts, EMPTY_RUN)
    .some((finding) => finding.code === "RUNTIME_MISMATCH"));
  assert(diagnose("", extractReadmePlan("# App\n\nRequires Python >=3.10."), facts, EMPTY_RUN)
    .some((finding) => finding.code === "RUNTIME_MISMATCH"));
});

test("install timeout is reported as runner limitation, not broken install", () => {
  const run: ExecutionObservation = {
    ...EMPTY_RUN,
    install: {
      command: "npm ci",
      exitCode: 124,
      stdout: "",
      stderr: "",
      timedOut: true,
    },
    startCommand: "npm run dev",
  };
  const findings = diagnose("", extractReadmePlan(""), BASE_FACTS, run);
  assert(findings.some((finding) => finding.code === "RUNNER_TIMEOUT"));
  assert(!findings.some((finding) => finding.code === "INSTALL_BROKEN"));
  assert(!findings.some((finding) => finding.code === "COMMAND_BROKEN"));
});

test("startup observation timeout is reported as runner limitation", () => {
  const run: ExecutionObservation = {
    ...EMPTY_RUN,
    startCommand: "npm run dev",
    startupTimedOut: true,
  };
  const findings = diagnose("", extractReadmePlan(""), BASE_FACTS, run);
  assert(findings.some((finding) => finding.code === "RUNNER_TIMEOUT"));
  assert(!findings.some((finding) => finding.code === "COMMAND_BROKEN"));
});

test("listener without HTTP response after process exit is a startup failure", () => {
  const run: ExecutionObservation = {
    ...EMPTY_RUN,
    startCommand: "npm run dev",
  };
  const findings = diagnose("", extractReadmePlan(""), BASE_FACTS, run);
  assert(findings.some((finding) => finding.code === "COMMAND_BROKEN"));
});

test("HTTP 5xx is a startup failure", () => {
  const run: ExecutionObservation = {
    ...EMPTY_RUN,
    startCommand: "npm run dev",
    observedPort: 3000,
    observedUrl: "https://example.test",
    httpStatus: 500,
  };
  const findings = diagnose("", extractReadmePlan(""), BASE_FACTS, run);
  assert(findings.some((finding) => finding.code === "COMMAND_BROKEN"));
});
