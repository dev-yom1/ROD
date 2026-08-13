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

export function renderReport(findings: Finding[], observedUrl: string | null): string {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const infos = findings.filter((f) => f.severity === "info").length;
  const summary = findings.length === 0
    ? "✅ Fresh onboarding succeeded with no documentation issues detected."
    : `Found **${findings.length}** onboarding issue${findings.length === 1 ? "" : "s"} (${errors} errors, ${warnings} warnings, ${infos} notes).`;
  const runtime = observedUrl ? `\n\nObserved app URL: \`${observedUrl}\`` : "";
  const body = findings.length ? findings.map(renderFinding).join("\n\n---\n\n") : "";
  return `${REPORT_MARKER}\n## 🩺 Repo Onboarding Doctor\n\n${summary}${runtime}${body ? `\n\n${body}` : ""}\n\n<sub>ROD runs setup in an isolated fresh environment and never forwards the GitHub App installation token into repository code.</sub>`;
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
      summary: "Running setup from a fresh isolated environment.",
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

export async function upsertPullRequestReport(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  report: string,
): Promise<void> {
  const comments = await octokit.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  const previous = (comments as Array<{ id: number; body?: string | null }>).find((comment) => comment.body?.includes(REPORT_MARKER));
  if (previous) {
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner,
      repo,
      comment_id: previous.id,
      body: report,
    });
    return;
  }
  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner,
    repo,
    issue_number: pullNumber,
    body: report,
  });
}
