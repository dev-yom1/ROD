import { buildRepoFacts } from "../analyzer/repo-facts";
import { diagnose } from "../analyzer/diagnose";
import { extractReadmePlan } from "../analyzer/readme";
import { githubConfig } from "../config";
import {
  ensureCheckRun,
  findWorkflowCheckRun,
  obsoleteWorkflowCheckIfPresent,
} from "../github/check-run";
import { getInstallationOctokit } from "../github/client";
import { downloadRepositoryArchive, fetchRepositoryMetadata } from "../github/repository";
import {
  completeCheckRun,
  failCheckRun,
  getCurrentPullHeadSha,
  obsoleteCheckRun,
  renderReport,
  upsertPullRequestReport,
} from "../github/reporter";
import { runSandboxDiagnosis } from "../runner/sandbox";

export interface DiagnosePullRequestInput {
  installationId: number;
  baseRepository: string;
  sourceRepository: string;
  pullNumber: number;
  headSha: string;
}

export interface DiagnosePullRequestContext {
  workflowRunId: string;
}

export type DiagnosePullRequestResult =
  | {
      status: "published";
      headSha: string;
      findingCount: number;
    }
  | {
      status: "superseded";
      headSha: string;
      currentHeadSha: string;
    };

function splitRepository(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) {
    throw new Error(`Invalid repository name: ${fullName}`);
  }
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

function superseded(headSha: string, currentHeadSha: string): DiagnosePullRequestResult {
  return { status: "superseded", headSha, currentHeadSha };
}

export async function diagnosePullRequest(
  input: DiagnosePullRequestInput,
  context: DiagnosePullRequestContext,
): Promise<DiagnosePullRequestResult> {
  const octokit = await getInstallationOctokit(input.installationId);
  const rodAppId = githubConfig().appId;
  const base = splitRepository(input.baseRepository);
  const source = splitRepository(input.sourceRepository);

  // A retry may begin after this Workflow already created a Check Run on an older SHA.
  // If the PR moved, settle that existing Check before returning superseded so it cannot
  // remain in_progress forever.
  const initialHeadSha = await getCurrentPullHeadSha(
    octokit,
    base.owner,
    base.repo,
    input.pullNumber,
  );
  if (initialHeadSha !== input.headSha) {
    await obsoleteWorkflowCheckIfPresent(
      octokit,
      base.owner,
      base.repo,
      input.pullNumber,
      input.headSha,
      rodAppId,
      context.workflowRunId,
      initialHeadSha,
    );
    return superseded(input.headSha, initialHeadSha);
  }

  const checkRunId = await ensureCheckRun(
    octokit,
    base.owner,
    base.repo,
    input.pullNumber,
    input.headSha,
    rodAppId,
    context.workflowRunId,
  );

  const metadata = await fetchRepositoryMetadata(
    octokit,
    source.owner,
    source.repo,
    input.headSha,
  );
  const plan = extractReadmePlan(metadata.readme);
  const initialFacts = buildRepoFacts({
    packageJson: metadata.packageJson,
    pyproject: metadata.pyproject,
    nvmrc: metadata.nvmrc,
    nodeVersion: metadata.nodeVersion,
    pythonVersion: metadata.pythonVersion,
    lockfiles: metadata.lockfiles,
    envExample: metadata.envExample,
  });

  const archive = await downloadRepositoryArchive(
    octokit,
    source.owner,
    source.repo,
    input.headSha,
  );

  // Archive download is cheap compared with starting an isolated runtime. Re-check
  // immediately before Sandbox allocation so queued/slow obsolete runs exit here.
  const headBeforeSandbox = await getCurrentPullHeadSha(
    octokit,
    base.owner,
    base.repo,
    input.pullNumber,
  );
  if (headBeforeSandbox !== input.headSha) {
    await obsoleteCheckRun(
      octokit,
      base.owner,
      base.repo,
      checkRunId,
      headBeforeSandbox,
    );
    return superseded(input.headSha, headBeforeSandbox);
  }

  const sandboxResult = await runSandboxDiagnosis(archive, plan, initialFacts);
  const facts = buildRepoFacts({
    packageJson: metadata.packageJson,
    pyproject: metadata.pyproject,
    nvmrc: metadata.nvmrc,
    nodeVersion: metadata.nodeVersion,
    pythonVersion: metadata.pythonVersion,
    lockfiles: metadata.lockfiles,
    envExample: metadata.envExample,
    requiredEnv: sandboxResult.requiredEnv,
  });
  const findings = diagnose(metadata.readme, plan, facts, sandboxResult.execution);
  const report = renderReport(
    findings,
    sandboxResult.execution.observedUrl,
    input.headSha,
    sandboxResult.execution.httpStatus,
  );

  const publication = await upsertPullRequestReport(
    octokit,
    base.owner,
    base.repo,
    input.pullNumber,
    input.headSha,
    rodAppId,
    report,
  );
  if (!publication.updated) {
    await obsoleteCheckRun(
      octokit,
      base.owner,
      base.repo,
      checkRunId,
      publication.currentHeadSha,
    );
    return superseded(input.headSha, publication.currentHeadSha);
  }

  await completeCheckRun(
    octokit,
    base.owner,
    base.repo,
    checkRunId,
    findings,
  );

  return {
    status: "published",
    headSha: input.headSha,
    findingCount: findings.length,
  };
}

export async function failPullRequestDiagnosis(
  input: DiagnosePullRequestInput,
  context: DiagnosePullRequestContext,
  errorMessage: string,
): Promise<void> {
  const octokit = await getInstallationOctokit(input.installationId);
  const rodAppId = githubConfig().appId;
  const base = splitRepository(input.baseRepository);
  const checkRunId = await findWorkflowCheckRun(
    octokit,
    base.owner,
    base.repo,
    input.pullNumber,
    input.headSha,
    rodAppId,
    context.workflowRunId,
  );

  if (checkRunId === null) return;
  await failCheckRun(
    octokit,
    base.owner,
    base.repo,
    checkRunId,
    new Error(errorMessage),
  );
}
