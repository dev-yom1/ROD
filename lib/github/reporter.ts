import type { Octokit } from "octokit";
import type { Finding } from "../analyzer/types";

const REPORT_MARKER = "<!-- rod-report -->";
const CHECK_NAME = "Repo Onboarding Doctor";

function icon(severity: Finding["severity"]): string {
  if (severity === "error") return "🔴";
  if (severity === "warning") return "🟠";
  return "🟡";
}

function renderFinding(finding: Finding): string {
  const evidence = finding.evidence?.filter(Boolean).map((item) => `\n\`\`\`text\n${item}\n\`\`\``).join("") ?? "";
  const suggestion = finding.suggestion ? `\n\n**Suggested fix:** ${finding.suggestion}` : "";
  return `### ${icon(finding.severity)} ${finding.title}\n\n${finding.detail}${evidence}${suggestion}`;
}

export function renderReport(
  findings: Finding[],
  observedUrl: string | null,
  headSha: string,
  httpStatus: number | null,
): string {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const infos = findings.filter((f) => f.severity === "info").length;
  const summary = findings.length === 0
    ? "✅ Fresh onboarding succeeded with no documentation issues detected."
    : `Found **${findings.length}** onboarding issue${findings.length === 1 ? "" : "s"} (${errors} errors, ${warnings} warnings, ${infos} notes).`;
  const runtime = observedUrl
    ? `\n\nObserved app URL: \`${observedUrl}\`${httpStatus !== null ? ` (HTTP ${httpStatus})` : ""}`
    : "";
  const body = findings.length ? findings.map(renderFinding).join("\n\n---\n\n") : "";
  return `${REPORT_MARKER}\n## 🩺 Repo Onboarding Doctor\n\n${summary}${runtime}\n\nCommit: \`${headSha.slice(0, 12)}\`${body ? `\n\n${body}` : ""}\n\n<sub>ROD runs setup in an isolated fresh environment and never forwards the GitHub App installation token into repository code.</sub>`;
}

export async function createCheckRun(octokit: Octokit, owner: string, repo: string, headSha: string): Promise<number> {
  const response = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
    output: {
      title: "ROD is reproducing README onboarding",
      summary: `Running setup from a fresh isolated environment for ${headSha.slice(0, 12)}.`,
    },
  });
  return (response.data as { id: number }).id;
}

export async function completeCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunId: number,
  findings: Finding[],
): Promise<void> {
  const hasError = findings.some((finding) => finding.severity === "error");
  const hasWarning = findings.some((finding) => finding.severity === "warning");
  const conclusion = hasError ? "failure" : hasWarning ? "neutral" : "success";
  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: findings.length ? `${findings.length} onboarding finding${findings.length === 1 ? "" : "s"}` : "README onboarding reproduced successfully",
      summary: findings.length
        ? findings.map((finding) => `- ${finding.code}: ${finding.title}`).join("\n")
        : "ROD installed dependencies and reached the development server without finding documentation drift.",
    },
  });
}

export async function obsoleteCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunId: number,
  currentHeadSha: string,
): Promise<void> {
  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion: "neutral",
    completed_at: new Date().toISOString(),
    output: {
      title: "ROD diagnosis superseded",
      summary: `The pull request moved to ${currentHeadSha.slice(0, 12)} before this diagnosis finished, so its PR report was not updated.`,
    },
  });
}

export async function failCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunId: number,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
    owner,
    repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion: "failure",
    completed_at: new Date().toISOString(),
    output: {
      title: "ROD diagnosis failed",
      summary: message.slice(0, 65000),
    },
  });
}

export async function getCurrentPullHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string> {
  const response = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: pullNumber,
  });
  return (response.data as { head: { sha: string } }).head.sha;
}

async function markerComments(octokit: Octokit, owner: string, repo: string, pullNumber: number) {
  const comments = await octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  return (comments as Array<{ id: number; body?: string | null }>)
    .filter((comment) => comment.body?.includes(REPORT_MARKER))
    .sort((a, b) => a.id - b.id);
}

async function deleteDuplicateReports(
  octokit: Octokit,
  owner: string,
  repo: string,
  canonicalId: number,
  comments: Array<{ id: number }>,
): Promise<void> {
  for (const comment of comments) {
    if (comment.id === canonicalId) continue;
    await octokit.request("DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner,
      repo,
      comment_id: comment.id,
    }).catch(() => undefined);
  }
}

export async function upsertPullRequestReport(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  expectedHeadSha: string,
  report: string,
): Promise<{ updated: boolean; currentHeadSha: string }> {
  let currentHeadSha = await getCurrentPullHeadSha(octokit, owner, repo, pullNumber);
  if (currentHeadSha !== expectedHeadSha) return { updated: false, currentHeadSha };

  let comments = await markerComments(octokit, owner, repo, pullNumber);
  currentHeadSha = await getCurrentPullHeadSha(octokit, owner, repo, pullNumber);
  if (currentHeadSha !== expectedHeadSha) return { updated: false, currentHeadSha };

  if (comments.length > 0) {
    const canonical = comments[0];
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner,
      repo,
      comment_id: canonical.id,
      body: report,
    });
    await deleteDuplicateReports(octokit, owner, repo, canonical.id, comments);
    return { updated: true, currentHeadSha };
  }

  const created = await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: pullNumber,
    body: report,
  });
  const createdId = (created.data as { id: number }).id;

  // Converge same-head concurrent first runs back to one marker comment.
  comments = await markerComments(octokit, owner, repo, pullNumber);
  const canonical = comments[0] ?? { id: createdId };
  if (canonical.id !== createdId) {
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner,
      repo,
      comment_id: canonical.id,
      body: report,
    });
  }
  await deleteDuplicateReports(octokit, owner, repo, canonical.id, comments);
  return { updated: true, currentHeadSha };
}
