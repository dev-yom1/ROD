import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("webhook claims a GitHub delivery before starting a durable workflow", () => {
  const route = source("app/api/github/webhook/route.ts");
  assert.match(route, /from "workflow\/api"/);
  assert.match(route, /x-github-delivery/);
  assert.match(route, /claimGitHubDelivery/);
  assert.match(route, /releaseGitHubDeliveryClaim/);
  assert.match(route, /claimGitHubDelivery\([\s\S]*start\(diagnosePullRequestWorkflow/);
  assert.match(route, /deliveryClaimToken: claimed\.claim\.token/);
  assert.match(route, /if \(!claimed\.claimed\)[\s\S]*status: 202/);
  assert.doesNotMatch(route, /\bafter\s*\(/);
  assert.doesNotMatch(route, /maxDuration/);
});

test("Next.js config enables Workflow SDK transformation", () => {
  const config = source("next.config.ts");
  assert.match(config, /withWorkflow/);
  assert.match(config, /export default withWorkflow\(nextConfig\)/);
});

test("workflow confirms delivery ownership before diagnosis work", () => {
  const workflow = source("workflows/diagnose-pull-request.ts");
  assert.match(workflow, /"use workflow"/);
  assert.match(workflow, /"use step"/);
  assert.match(workflow, /confirmGitHubDeliveryClaim/);
  assert.match(workflow, /await confirmDeliveryStartStep\([\s\S]*await runDiagnosisStep\(/);
  assert.match(workflow, /if \(!ownsDelivery\)[\s\S]*status: "duplicate"/);
  assert.match(workflow, /await import\("\.\.\/lib\/orchestrator\/diagnose-pr"\)/);
});

test("stale retry settles an existing Workflow Check before returning", () => {
  const orchestrator = source("lib/orchestrator/diagnose-pr.ts");
  assert.match(orchestrator, /if \(initialHeadSha !== input\.headSha\)[\s\S]*obsoleteWorkflowCheckIfPresent\(/);
  assert.match(orchestrator, /obsoleteWorkflowCheckIfPresent\([\s\S]*context\.workflowRunId[\s\S]*initialHeadSha/);
});
