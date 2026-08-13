import { buildRepoFacts } from "../analyzer/repo-facts";
import { diagnose } from "../analyzer/diagnose";
import { extractReadmePlan } from "../analyzer/readme";
import { getInstallationOctokit } from "../github/client";
import { downloadRepositoryArchive, fetchRepositoryMetadata } from "../github/repository";
import {
  completeCheckRun,
  createCheckRun,
  failCheckRun,
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

function splitRepository(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) throw new Error(`Invalid repository name: ${fullName}`);
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

export async function diagnosePullRequest(input: DiagnosePullRequestInput): Promise<void> {
  const octokit = await getInstallationOctokit(input.installationId);
  const base = splitRepository(input.baseRepository);
  const source = splitRepository(input.sourceRepository);
  let checkRunId: number | null = null;

  try {
    checkRunId = await createCheckRun(octokit, base.owner, base.repo, input.headSha);
    const metadata = await fetchRepositoryMetadata(octokit, source.owner, source.repo, input.headSha);
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

    const archive = await downloadRepositoryArchive(octokit, source.owner, source.repo, input.headSha);
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
      report,
    );
    if (!publication.updated) {
      await obsoleteCheckRun(octokit, base.owner, base.repo, checkRunId, publication.currentHeadSha);
      return;
    }

    await completeCheckRun(octokit, base.owner, base.repo, checkRunId, findings);
  } catch (error) {
    if (checkRunId !== null) {
      await failCheckRun(octokit, base.owner, base.repo, checkRunId, error).catch(() => undefined);
    }
    throw error;
  }
}
