import type { Octokit } from "octokit";
import { obsoleteCheckRun } from "./reporter";

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
  const checkRuns = await octokit.paginate(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    {
      owner,
      repo,
      ref: headSha,
      check_name: CHECK_NAME,
      filter: "all",
      app_id: rodAppId,
      per_page: 100,
    },
    (response) => (response.data as { check_runs: CheckRunSummary[] }).check_runs,
  );

  const existing = (checkRuns as CheckRunSummary[]).find(
    (checkRun) => (
      checkRun.external_id === idempotencyKey
      && checkRun.app?.id === rodAppId
    ),
  );

  return existing?.id ?? null;
}

export async function obsoleteWorkflowCheckIfPresent(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  rodAppId: number,
  workflowRunId: string,
  currentHeadSha: string,
): Promise<boolean> {
  const checkRunId = await findWorkflowCheckRun(
    octokit,
    owner,
    repo,
    pullNumber,
    headSha,
    rodAppId,
    workflowRunId,
  );
  if (checkRunId === null) return false;

  await obsoleteCheckRun(
    octokit,
    owner,
    repo,
    checkRunId,
    currentHeadSha,
  );
  return true;
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
