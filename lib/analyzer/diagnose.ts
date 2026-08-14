import { npmScriptReferencedByCommand } from "./readme";
import { nodeReadmeRequirementFitsRepo, pythonReadmeRequirementFitsRepo } from "./runtime";
import type {
  CommandObservation,
  ExecutionObservation,
  Finding,
  ReadmePlan,
  ReadmeStep,
  RepoFacts,
  StepResult,
} from "./types";

const ENV_COPY_COMMAND = /^(?:cp|copy)\s+\.env(?:\.example|\.sample)\s+\.env(?:\.local|\.development\.local)?\s*$/i;

function excerpt(text: string, max = 500): string {
  const normalized = text.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function commandFailed(command: CommandObservation): boolean {
  return command.timedOut || command.exitCode !== 0;
}

function stepResultById(run: ExecutionObservation): Map<string, StepResult> | null {
  if (!run.stepResults) return null;
  return new Map(run.stepResults.map((result) => [result.stepId, result]));
}

function unreproducedSteps(plan: ReadmePlan, run: ExecutionObservation): ReadmeStep[] {
  const resultMap = stepResultById(run);
  if (resultMap) {
    return plan.steps.filter((step) => {
      const result = resultMap.get(step.id);
      if (!result) return true;
      return result.status === "skipped"
        && (result.reason === "unsafe" || result.reason === "unsupported" || result.reason === "after-start");
    });
  }

  const reproduced = new Set(run.preparation.map((command) => command.command));
  if (plan.installCommand && run.install?.command === plan.installCommand) reproduced.add(plan.installCommand);
  if (plan.startCommand && run.startCommand === plan.startCommand) reproduced.add(plan.startCommand);
  return plan.steps.filter((step) => !reproduced.has(step.command));
}

function successfulEnvCopy(plan: ReadmePlan, run: ExecutionObservation): boolean {
  const resultMap = stepResultById(run);
  if (resultMap) {
    return plan.steps.some((step) => {
      if (!ENV_COPY_COMMAND.test(step.command)) return false;
      const result = resultMap.get(step.id);
      return result?.status === "executed" && Boolean(result.observation && !commandFailed(result.observation));
    });
  }
  return run.preparation.some((command) => ENV_COPY_COMMAND.test(command.command) && !commandFailed(command));
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

function preexistingExpectedPortConflict(plan: ReadmePlan, run: ExecutionObservation): number | null {
  if (!run.preexistingPorts?.length || run.observedPort !== null) return null;
  if (plan.expectedPort && run.preexistingPorts.includes(plan.expectedPort)) return plan.expectedPort;
  if (run.startCommand) {
    const match = run.startCommand.match(/(?:--port(?:=|\s+)|-p\s+|PORT=)(\d{2,5})\b/i);
    const hintedPort = match ? Number(match[1]) : null;
    if (hintedPort && run.preexistingPorts.includes(hintedPort)) return hintedPort;
  }
  return null;
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
      detail: `ROD inferred that dependencies must be installed with ${facts.inferredInstallCommand}, but found no install step in the selected onboarding flow.`,
      suggestion: "Document the dependency installation command before the development/start command.",
      evidence: [facts.inferredInstallCommand],
    });
  }

  if (facts.inferredStartCommand && !plan.startCommand) {
    findings.push({
      code: "START_STEP_MISSING",
      severity: "warning",
      title: "Application start command is missing from the README",
      detail: "ROD inferred a start command from repository configuration, but the selected onboarding flow does not tell a new contributor how to start the application.",
      suggestion: "Document the intended development/start command in the onboarding flow.",
      evidence: [facts.inferredStartCommand],
    });
  }

  for (const step of plan.steps) {
    const script = npmScriptReferencedByCommand(step.command);
    if (script && !facts.scripts[script]) {
      findings.push({
        code: "DOC_STALE",
        severity: "warning",
        title: `README references a missing script: ${script}`,
        detail: "A command in the selected onboarding flow refers to a package script that is not present in package.json.",
        evidence: [step.command],
        suggestion: "Remove the stale command or restore the script it refers to.",
      });
    }
  }

  // Runtime incompatibility means repository commands were intentionally not attempted. Do not
  // convert that one runner limitation into command/env execution findings.
  if (run.runtimeIssue) return findings;

  for (const step of unreproducedSteps(plan, run)) {
    findings.push({
      code: "RUNNER_COMMAND_UNSUPPORTED",
      severity: "warning",
      title: "README command was not reproduced",
      detail: "ROD did not reproduce this occurrence in the selected onboarding flow. Inferred fallback commands are diagnostic-only and never count as reproducing a documented step.",
      evidence: [step.command],
      suggestion: "Teach ROD how to reproduce this step explicitly, or rewrite the onboarding flow using runner-supported commands.",
    });
  }

  for (const preparation of run.preparation.filter(commandFailed)) {
    const output = preparation.stderr || preparation.stdout;
    findings.push({
      code: "PREPARATION_BROKEN",
      severity: preparation.timedOut ? "warning" : "error",
      title: preparation.timedOut ? "README preparation step timed out" : "README preparation step failed",
      detail: preparation.timedOut
        ? "ROD could not finish a documented preparation step within the preparation budget."
        : `A documented preparation step exited with code ${preparation.exitCode} before dependency installation/startup.`,
      evidence: [preparation.command, output].filter(Boolean),
      suggestion: "Fix the documented preparation step or document a portable equivalent that works in a fresh environment.",
    });
  }

  const envExamplePreparationSucceeded = successfulEnvCopy(plan, run);
  const documentedEnv = new Set(facts.envExampleVars);
  for (const name of facts.requiredEnv) {
    const namedInReadme = readme.includes(name);
    const coveredByExample = envExamplePreparationSucceeded && documentedEnv.has(name);
    if (!namedInReadme && !coveredByExample) {
      findings.push({
        code: "ENV_MISSING",
        severity: "warning",
        title: `Environment variable ${name} is not documented`,
        detail: `Source code references ${name}, but the README does not mention it and a successful documented .env example flow did not cover it.`,
        suggestion: `Document ${name} or add it to .env.example and tell users to copy that file.`,
      });
    }
  }

  if (run.install?.timedOut) {
    findings.push({
      code: "RUNNER_TIMEOUT",
      severity: "warning",
      title: "ROD timed out while installing dependencies",
      detail: "ROD reached its install execution budget. This does not prove the repository install is broken.",
      evidence: [run.install.command, excerpt(run.install.stderr || run.install.stdout)].filter(Boolean),
      suggestion: "Treat this as an inconclusive runner limitation. Retry with a larger durable execution budget before changing repository setup instructions.",
    });
  } else if (run.install && run.install.exitCode !== 0) {
    findings.push({
      code: "INSTALL_BROKEN",
      severity: "error",
      title: "Fresh dependency installation failed",
      detail: `The dependency installation step exited with code ${run.install.exitCode}.`,
      evidence: [run.install.command, excerpt(run.install.stderr || run.install.stdout)].filter(Boolean),
      suggestion: "Update the install instructions or dependency/lockfile state so a clean environment can install successfully.",
    });
  }

  const installBlockedStartup = Boolean(run.install && (run.install.timedOut || run.install.exitCode !== 0));
  const preexistingConflict = preexistingExpectedPortConflict(plan, run);
  if (preexistingConflict !== null) {
    findings.push({
      code: "RUNNER_PREEXISTING_LISTENER",
      severity: "warning",
      title: "Expected startup port was already in use before the start command",
      detail: `Port ${preexistingConflict} was already listening immediately before ROD launched the documented start command, so that listener was excluded from startup success detection.`,
      suggestion: "Ensure install/preparation steps do not leave a background server running on the application port.",
    });
  }

  if (!run.runtimeIssue && run.startCommand && !installBlockedStartup) {
    if (run.startupTimedOut) {
      findings.push({
        code: "RUNNER_TIMEOUT",
        severity: "warning",
        title: "ROD timed out waiting for the application to become reachable",
        detail: "The start process was still running when the HTTP observation budget expired. This does not prove the start command is broken.",
        evidence: [run.startCommand, run.startLog ? excerpt(run.startLog) : ""].filter(Boolean),
        suggestion: "Treat this run as inconclusive or move the diagnosis to a longer-lived durable runner before changing the README.",
      });
    } else if (preexistingConflict === null && (run.observedPort === null || run.httpStatus === null || run.httpStatus >= 500)) {
      const responseDetail = run.httpStatus === null
        ? "No HTTP response was received before the start process exited or became unusable."
        : `The probed application endpoint returned HTTP ${run.httpStatus}.`;
      findings.push({
        code: "COMMAND_BROKEN",
        severity: "error",
        title: "Development server did not become reachable",
        detail: `ROD launched the selected start command, but a usable new HTTP endpoint was not observed. ${responseDetail}`,
        evidence: [run.startCommand, run.startLog ? excerpt(run.startLog) : ""].filter(Boolean),
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
      detail: `ROD reached the app on port ${observedPort}, but the selected onboarding flow does not provide a localhost URL with a port.`,
      suggestion: `Add a line such as http://localhost:${observedPort} after the start command.`,
    });
  }

  return findings;
}
