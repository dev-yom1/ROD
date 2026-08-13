import assert from "node:assert/strict";
import test from "node:test";
import { diagnose } from "../lib/analyzer/diagnose";
import { extractReadmePlan, isSafeOnboardingCommand } from "../lib/analyzer/readme";
import { buildRepoFacts } from "../lib/analyzer/repo-facts";

const EMPTY_RUN = {
  install: null,
  startCommand: null,
  startLog: "",
  observedPorts: [],
  observedUrl: null,
  httpStatus: null,
};

test("extracts install, start and port from README", () => {
  const plan = extractReadmePlan(`
# App
Requires Node.js 22.

\`\`\`bash
npm ci
npm run dev
\`\`\`

Open http://localhost:3000.
`);
  assert.equal(plan.installCommand, "npm ci");
  assert.equal(plan.startCommand, "npm run dev");
  assert.equal(plan.expectedPort, 3000);
  assert.equal(plan.nodeRequirement, "22");
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

test("does not flag env var when README documents the .env.example copy flow", () => {
  const readme = `# App\n\n\`\`\`bash\ncp .env.example .env\nnpm ci\n\`\`\``;
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
  const findings = diagnose(readme, plan, facts, EMPTY_RUN);
  assert(!findings.some((finding) => finding.code === "ENV_MISSING"));
});

test("blocks shell chaining in README commands", () => {
  assert.equal(isSafeOnboardingCommand("npm run dev; echo nope"), false);
  assert.equal(isSafeOnboardingCommand("npm ci"), true);
});
