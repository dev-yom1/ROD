import type { Octokit } from "octokit";

const CHECK_NAME = "Repo Onboarding Doctor";

interface CheckRunSummary {
  id: number;
  external_id?: string | null;
  app?: { id: number } | null;
}

function externalId(workflowRunId: string, pullNumber: number): string {
  return `rod:workflow:${workflowRunId}:pr:${pullNumber}`;
}

export async function findWorkflowCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  rodAppId: number,
  workflowRunId: string,
): Promise<number | null> {
  const idempotencyKey = externalId(workflowRunId, pullNumber);
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    {
      owner,
      repo,
      ref: headSha,
      check_name: CHECK_NAME,
      per_page: 100,
    },
  );

  const existing = (response.data as { check_runs: CheckRunSummary[] }).check_runs.find(
    (checkRun) => (
      checkRun.external_id === idempotencyKey
      && checkRun.app?.id === rodAppId
    ),
  );

  return existing?.id ?? null;
}

export async function ensureCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  rodAppId: number,
  workflowRunId: string,
): Promise<number> {
  const existingId = await findWorkflowCheckRun(
    octokit,
    owner,
    repo,
    pullNumber,
    headSha,
    rodAppId,
    workflowRunId,
  );
  if (existingId !== null) return existingId;

  const response = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: headSha,
    external_id: externalId(workflowRunId, pullNumber),
    status: "in_progress",
    started_at: new Date().toISOString(),
    output: {
      title: "ROD is reproducing README onboarding",
      summary: `Workflow ${workflowRunId} is checking ${headSha.slice(0, 12)} in a fresh isolated environment.`,
    },
  });

  return (response.data as { id: number }).id;
}
