import type { Octokit } from "octokit";

const CHECK_NAME = "Repo Onboarding Doctor";

interface CheckRunSummary {
  id: number;
  external_id?: string | null;
  app?: { id: number } | null;
}

function externalId(pullNumber: number, headSha: string): string {
  return `rod:pr:${pullNumber}:sha:${headSha}`;
}

export async function ensureCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  rodAppId: number,
): Promise<number> {
  const idempotencyKey = externalId(pullNumber, headSha);
  const existingResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    {
      owner,
      repo,
      ref: headSha,
      check_name: CHECK_NAME,
      per_page: 100,
    },
  );

  const existing = (existingResponse.data as { check_runs: CheckRunSummary[] }).check_runs.find(
    (checkRun) => (
      checkRun.external_id === idempotencyKey
      && checkRun.app?.id === rodAppId
    ),
  );

  if (existing) {
    return existing.id;
  }

  const response = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: headSha,
    external_id: idempotencyKey,
    status: "in_progress",
    started_at: new Date().toISOString(),
    output: {
      title: "ROD is reproducing README onboarding",
      summary: `Running setup from a fresh isolated environment for ${headSha.slice(0, 12)}.`,
    },
  });

  return (response.data as { id: number }).id;
}
