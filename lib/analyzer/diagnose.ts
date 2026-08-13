import { npmScriptReferencedByCommand } from "./readme";
import type { ExecutionObservation, Finding, ReadmePlan, RepoFacts } from "./types";

function major(version: string | null): number | null {
  if (!version) return null;
  const match = version.match(/\d+/);
  return match ? Number(match[0]) : null;
}

function excerpt(text: string, max = 500): string {
  const normalized = text.trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

export function diagnose(readme: string, plan: ReadmePlan, facts: RepoFacts, run: ExecutionObservation): Finding[] {
  const findings: Finding[] = [];

  if (facts.nodeRequirement && !plan.nodeRequirement) {
    findings.push({
      code: "RUNTIME_UNDOCUMENTED",
      severity: "warning",
      title: "Node.js version is not documented",
      detail: `The repository declares Node.js ${facts.nodeRequirement}, but the README does not state a Node.js version.`,
      suggestion: `Add a Requirements section that names Node.js ${facts.nodeRequirement}.`,
    });
  } else if (facts.nodeRequirement && plan.nodeRequirement && major(facts.nodeRequirement) !== major(plan.nodeRequirement)) {
    findings.push({
      code: "RUNTIME_MISMATCH",
      severity: "warning",
      title: "README Node.js version disagrees with the repository",
      detail: `README mentions Node.js ${plan.nodeRequirement}, while repository configuration indicates ${facts.nodeRequirement}.`,
      suggestion: `Update the README to match ${facts.nodeRequirement}, or change the repository runtime configuration.`,
    });
  }

  if (facts.pythonRequirement && !plan.pythonRequirement) {
    findings.push({
      code: "RUNTIME_UNDOCUMENTED",
      severity: "warning",
      title: "Python version is not documented",
      detail: `The repository declares Python ${facts.pythonRequirement}, but the README does not state a Python version.`,
      suggestion: `Add Python ${facts.pythonRequirement} to the prerequisites.`,
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

  const documentedEnv = new Set(facts.envExampleVars);
  for (const name of facts.requiredEnv) {
    const namedInReadme = readme.includes(name);
    const coveredByExample = plan.copiesEnvExample && documentedEnv.has(name);
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

  if (run.install && run.install.exitCode !== 0) {
    findings.push({
      code: "INSTALL_BROKEN",
      severity: "error",
      title: "Fresh dependency installation failed",
      detail: `\`${run.install.command}\` exited with code ${run.install.exitCode}.`,
      evidence: [excerpt(run.install.stderr || run.install.stdout)],
      suggestion: "Update the install instructions or dependency/lockfile state so a clean environment can install successfully.",
    });
  }

  if (run.startCommand && run.install?.exitCode !== 0) {
    // Avoid duplicating a startup failure when install already failed.
  } else if (run.startCommand && run.observedPorts.length === 0) {
    findings.push({
      code: "COMMAND_BROKEN",
      severity: "error",
      title: "Development server did not become reachable",
      detail: `ROD started \`${run.startCommand}\` but did not observe a listening application port.`,
      evidence: run.startLog ? [excerpt(run.startLog)] : undefined,
      suggestion: "Verify the README start command and document any required environment variables or prerequisite services.",
    });
  }

  const observedPort = run.observedPorts[0] ?? null;
  if (observedPort && plan.expectedPort && observedPort !== plan.expectedPort) {
    findings.push({
      code: "PORT_MISMATCH",
      severity: "warning",
      title: "README port does not match the running app",
      detail: `README points to port ${plan.expectedPort}, but the fresh environment listened on port ${observedPort}.`,
      suggestion: `Change the README URL to use port ${observedPort}, or configure the app to use ${plan.expectedPort}.`,
    });
  } else if (observedPort && !plan.expectedPort) {
    findings.push({
      code: "START_URL_UNDOCUMENTED",
      severity: "info",
      title: "Startup URL is not documented",
      detail: `The app listened on port ${observedPort}, but README does not provide a localhost URL with a port.`,
      suggestion: `Add a line such as \`http://localhost:${observedPort}\` after the start command.`,
    });
  }

  return findings;
}
