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
  assert.match(route, /x-github-delivery/);
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

test("stale retry settles an existing Workflow Check before returning", () => {
  const orchestrator = source("lib/orchestrator/diagnose-pr.ts");
  assert.match(orchestrator, /if \(initialHeadSha !== input\.headSha\)[\s\S]*obsoleteWorkflowCheckIfPresent\(/);
  assert.match(orchestrator, /obsoleteWorkflowCheckIfPresent\([\s\S]*context\.workflowRunId[\s\S]*initialHeadSha/);
});

test("repository metadata reads raw GitHub content without object type assumptions", () => {
  const repository = source("lib/github/repository.ts");
  assert.match(repository, /application\/vnd\.github\.raw\+json/);
  assert.match(repository, /Authorization: `Bearer \$\{token\}`/);
  assert.match(repository, /response\.status === 404/);
  assert.doesNotMatch(repository, /data\.type/);
});
