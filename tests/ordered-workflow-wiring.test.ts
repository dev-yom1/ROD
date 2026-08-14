import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("webhook routes diagnosis through the ordered workflow", () => {
  const route = source("app/api/github/webhook/route.ts");
  assert.match(route, /diagnose-pull-request-ordered/);
  assert.match(route, /start\(diagnosePullRequestWorkflow/);
});

test("ordered workflow imports the ordered orchestrator inside durable steps", () => {
  const workflow = source("workflows/diagnose-pull-request-ordered.ts");
  assert.match(workflow, /"use workflow"/);
  assert.match(workflow, /"use step"/);
  assert.match(workflow, /ordered-diagnose-pr/);
});

test("ordered orchestrator sanitizes runner input without replacing the original diagnosis plan", () => {
  const orchestrator = source("lib/orchestrator/ordered-diagnose-pr.ts");
  assert.match(orchestrator, /const sandboxPlan = runnerReadmePlan\(plan\)/);
  assert.match(orchestrator, /runSandboxDiagnosis\(archive, sandboxPlan, sandboxFacts\)/);
  assert.match(orchestrator, /diagnose\(metadata\.readme, plan, facts, sandboxResult\.execution\)/);
});
