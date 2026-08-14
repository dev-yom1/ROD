import { npmScriptReferencedByCommand } from "./readme";
import { nodeReadmeRequirementFitsRepo, pythonReadmeRequirementFitsRepo } from "./runtime";
import type { CommandObservation, ExecutionObservation, Finding, ReadmePlan, RepoFacts } from "./types";

const ENV_COPY_COMMAND = /^(?:cp|copy)\s+\.env(?:\.example|\.sample)\s+\.env(?:\.local|\.development\.local)?\s*$/i;

function excerpt(text: string, max = 500): string {
  const normalized = text.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function commandFailed(command: CommandObservation): boolean {
  return command.timedOut || command.exitCode !== 0;
}

function pushRuntimeFinding(
  findings: Finding[],
  runtime: "Node.js" | "Python",
  repoRequirement: string | null,
  readmeRequirement: string | null,
  readmeFitsRepo: boolean | null,
): void {
  if (repoRequirement && !readmeRequirement) {
    findings.push({
      code: "RUNTIME_UNDOCUMENTED",
      severity: "warning",
      title: `${runtime} version is not documented`,
      detail: `The repository declares ${runtime} ${repoRequirement}, but the README does not state a ${runtime} version.`,
      suggestion: `Add ${runtime} ${repoRequirement} to the prerequisites.`,
    });
    return;
  }

  if (repoRequirement && readmeRequirement && readmeFitsRepo === false) {
    findings.push({
      code: "RUNTIME_MISMATCH",
      severity: "warning",
      title: `README ${runtime} version is broader than the repository supports`,
      detail: `README allows ${runtime} ${readmeRequirement}, while repository configuration allows ${repoRequirement}. The README range includes versions outside the repository range.`,
      suggestion: `Narrow the README requirement so every documented version is supported by the repository, for example ${repoRequirement}.`,
    });
  }
}

export function diagnose(readme: string, plan: ReadmePlan, facts: RepoFacts, run: ExecutionObservation): Finding[] {
  const findings: Finding[] = [];

  pushRuntimeFinding(
    findings,
    "Node.js",
    facts.nodeRequirement,
    plan.nodeRequirement,
    nodeReadmeRequirementFitsRepo(facts.nodeRequirement, plan.nodeRequirement),
  );
  pushRuntimeFinding(
    findings,
    "Python",
    facts.pythonRequirement,
    plan.pythonRequirement,
    pythonReadmeRequirementFitsRepo(facts.pythonRequirement, plan.pythonRequirement),
  );

  if (run.runtimeIssue) {
    findings.push({
      code: "RUNNER_RUNTIME_UNSUPPORTED",
      severity: "warning",
      title: "ROD cannot reproduce this runtime requirement yet",
      detail: run.runtimeIssue,
      suggestion: "Treat this as a ROD runner limitation, not a repository setup failure.",
    });
  }

  if (facts.inferredInstallCommand && !plan.installCommand) {
    findings.push({
      code: "INSTALL_STEP_MISSING",
      severity: "warning",
      title: "Dependency installation is missing from the README",
      detail: `ROD inferred that dependencies must be installed with \`${facts.inferredInstallCommand}\`, but found no install step in README shell examples.`,
      suggestion: `Document \`${facts.inferredInstallCommand}\` before the development/start command.`,
    });
  }

  if (facts.inferredStartCommand && !plan.startCommand) {
    findings.push({
      code: "START_STEP_MISSING",
      severity: "warning",
      title: "Application start command is missing from the README",
      detail: `ROD inferred \`${facts.inferredStartCommand}\` from repository configuration, but the README does not tell a new contributor how to start the application.`,
      suggestion: `Document \`${facts.inferredStartCommand}\` (or the intended equivalent) in the README.`,
    });
  }

  for (const command of run.unsupportedCommands) {
    findings.push({
      code: "RUNNER_COMMAND_UNSUPPORTED",
      severity: "warning",
      title: "README command could not be reproduced safely",
      detail: `The README documents \`${command}\`, but ROD's isolated runner does not execute this shell form. Any inferred fallback command is used only to gather diagnostic signal and does not count as reproducing the documented onboarding flow.`,
      suggestion: "Split the onboarding step into supported commands, or extend ROD's runner with a safe explicit implementation for this command form.",
    });
  }

  for (const preparation of run.preparation.filter(commandFailed)) {
    const output = preparation.stderr || preparation.stdout;
    findings.push({
      code: "PREPARATION_BROKEN",
      severity: preparation.timedOut ? "warning" : "error",
      title: preparation.timedOut ? "README preparation step timed out" : "README preparation step failed",
      detail: preparation.timedOut
        ? `ROD could not finish \`${preparation.command}\` within the preparation budget.`
        : `\`${preparation.command}\` exited with code ${preparation.exitCode} before dependency installation/startup.`,
      evidence: output ? [excerpt(output)] : undefined,
      suggestion: "Fix the documented preparation step or document a portable equivalent that works in a fresh environment.",
    });
  }

  for (const command of plan.commands) {
    const script = npmScriptReferencedByCommand(command);
    if (script && !facts.scripts[script]) {
      findings.push({
        code: "DOC_STALE",
        severity: "warning",
        title: `README references a missing script: ${script}`,
        detail: `The command \`${command}\` refers to a package script that is not present in package.json.`,
        suggestion: "Remove the stale command or restore the script it refers to.",
      });
    }
  }

  const envExamplePreparationSucceeded = run.preparation.some((command) => (
    ENV_COPY_COMMAND.test(command.command) && !commandFailed(command)
  ));
  const documentedEnv = new Set(facts.envExampleVars);
  for (const name of facts.requiredEnv) {
    const namedInReadme = readme.includes(name);
    const coveredByExample = envExamplePreparationSucceeded && documentedEnv.has(name);
    if (!namedInReadme && !coveredByExample) {
      findings.push({
        code: "ENV_MISSING",
        severity: "warning",
        title: `Environment variable ${name} is not documented`,
        detail: `Source code references \`${name}\`, but the README does not mention it and the documented .env example flow does not cover it.`,
        suggestion: `Document \`${name}\` or add it to .env.example and tell users to copy that file.`,
      });
    }
  }

  if (run.install?.timedOut) {
    findings.push({
      code: "RUNNER_TIMEOUT",
      severity: "warning",
      title: "ROD timed out while installing dependencies",
      detail: `ROD stopped \`${run.install.command}\` after reaching its install execution budget. This does not prove the repository install is broken.`,
      evidence: [excerpt(run.install.stderr || run.install.stdout)].filter(Boolean),
      suggestion: "Treat this as an inconclusive runner limitation. Retry with a larger durable execution budget before changing repository setup instructions.",
    });
  } else if (run.install && run.install.exitCode !== 0) {
    findings.push({
      code: "INSTALL_BROKEN",
      severity: "error",
      title: "Fresh dependency installation failed",
      detail: `\`${run.install.command}\` exited with code ${run.install.exitCode}.`,
      evidence: [excerpt(run.install.stderr || run.install.stdout)],
      suggestion: "Update the install instructions or dependency/lockfile state so a clean environment can install successfully.",
    });
  }

  const installBlockedStartup = Boolean(run.install && (run.install.timedOut || run.install.exitCode !== 0));
  if (!run.runtimeIssue && run.startCommand && !installBlockedStartup) {
    if (run.startupTimedOut) {
      findings.push({
        code: "RUNNER_TIMEOUT",
        severity: "warning",
        title: "ROD timed out waiting for the application to become reachable",
        detail: `ROD started \`${run.startCommand}\`, but the process was still running when the HTTP observation budget expired. This does not prove the start command is broken.`,
        evidence: run.startLog ? [excerpt(run.startLog)] : undefined,
        suggestion: "Treat this run as inconclusive or move the diagnosis to a longer-lived durable runner before changing the README.",
      });
    } else if (run.observedPort === null || run.httpStatus === null || run.httpStatus >= 500) {
      const responseDetail = run.httpStatus === null
        ? "No HTTP response was received before the start process exited or became unusable."
        : `The probed application endpoint returned HTTP ${run.httpStatus}.`;
      findings.push({
        code: "COMMAND_BROKEN",
        severity: "error",
        title: "Development server did not become reachable",
        detail: `ROD started \`${run.startCommand}\`, but a usable HTTP endpoint was not observed. ${responseDetail}`,
        evidence: run.startLog ? [excerpt(run.startLog)] : undefined,
        suggestion: "Verify the README start command and document any required environment variables or prerequisite services.",
      });
    }
  }

  const observedPort = run.observedPort;
  if (observedPort && plan.expectedPort && observedPort !== plan.expectedPort) {
    findings.push({
      code: "PORT_MISMATCH",
      severity: "warning",
      title: "README port does not match the running app",
      detail: `README points to port ${plan.expectedPort}, but the HTTP endpoint ROD reached was on port ${observedPort}.`,
      suggestion: `Change the README URL to use port ${observedPort}, or configure the app to use ${plan.expectedPort}.`,
    });
  } else if (observedPort && !plan.expectedPort) {
    findings.push({
      code: "START_URL_UNDOCUMENTED",
      severity: "info",
      title: "Startup URL is not documented",
      detail: `ROD reached the app on port ${observedPort}, but README does not provide a localhost URL with a port.`,
      suggestion: `Add a line such as \`http://localhost:${observedPort}\` after the start command.`,
    });
  }

  return findings;
}
