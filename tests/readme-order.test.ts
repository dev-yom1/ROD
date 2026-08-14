import assert from "node:assert/strict";
import test from "node:test";
import { extractReadmePlan } from "../lib/analyzer/readme";
import { orderedReadmeSteps, runnerReadmePlan } from "../lib/runner/readme-order";

function planFor(commands: string) {
  return extractReadmePlan(`# App\n\n\`\`\`bash\n${commands}\n\`\`\``);
}

test("does not move install before an earlier start command", () => {
  const plan = planFor("npm run dev\nnpm ci");
  const steps = orderedReadmeSteps(plan);

  assert.deepEqual(steps.map((step) => [step.role, step.command]), [
    ["start", "npm run dev"],
    ["skipped", "npm ci"],
  ]);

  const runnerPlan = runnerReadmePlan(plan);
  assert.deepEqual(runnerPlan.commands, ["npm run dev"]);
  assert.equal(runnerPlan.installCommand, null);
  assert.equal(runnerPlan.startCommand, "npm run dev");
});

test("does not move preparation ahead of an earlier install command", () => {
  const plan = planFor("npm ci\nmkdir generated\nnpm run dev");
  const steps = orderedReadmeSteps(plan);

  assert.deepEqual(steps.map((step) => [step.role, step.command]), [
    ["install", "npm ci"],
    ["skipped", "mkdir generated"],
    ["start", "npm run dev"],
  ]);

  assert.deepEqual(runnerReadmePlan(plan).commands, ["npm ci", "npm run dev"]);
});

test("preserves the supported preparation install start order", () => {
  const plan = planFor("mkdir generated\nnpm ci\nnpm run dev");

  assert.deepEqual(runnerReadmePlan(plan).commands, [
    "mkdir generated",
    "npm ci",
    "npm run dev",
  ]);
});

test("commands after start are never moved before the detached server", () => {
  const plan = planFor("npm ci\nnpm run dev\ntouch after-start");
  const steps = orderedReadmeSteps(plan);

  assert.deepEqual(steps.map((step) => [step.role, step.command]), [
    ["install", "npm ci"],
    ["start", "npm run dev"],
    ["skipped", "touch after-start"],
  ]);
});
