import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("webhook starts a durable workflow instead of using Next.js after", () => {
  const route = source("app/api/github/webhook/route.ts");
  assert.match(route, /from "workflow\/api"/);
  assert.match(route, /start\(diagnosePullRequestWorkflow/);
  assert.doesNotMatch(route, /\bafter\s*\(/);
  assert.doesNotMatch(route, /maxDuration/);
});

test("Next.js config enables Workflow SDK transformation", () => {
  const config = source("next.config.ts");
  assert.match(config, /withWorkflow/);
  assert.match(config, /export default withWorkflow\(nextConfig\)/);
});

test("diagnosis workflow keeps Node-only work inside a step", () => {
  const workflow = source("workflows/diagnose-pull-request.ts");
  assert.match(workflow, /"use workflow"/);
  assert.match(workflow, /"use step"/);
  assert.match(workflow, /await import\("\.\.\/lib\/orchestrator\/diagnose-pr"\)/);
});
