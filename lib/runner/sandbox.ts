import { Sandbox } from "@vercel/sandbox";
import { parseEnvScanOutput } from "../analyzer/env-scan";
import { isSafeOnboardingCommand } from "../analyzer/readme";
import type { CommandObservation, ExecutionObservation, ReadmePlan, RepoFacts } from "../analyzer/types";

const REPO_DIR = "/vercel/sandbox/repo";
const ARCHIVE_PATH = "/vercel/sandbox/rod-repo.tar.gz";
const COMMON_PORTS = [3000, 3001, 4173, 5000, 5173, 8000, 8080];

export interface SandboxDiagnosisResult {
  execution: ExecutionObservation;
  requiredEnv: string[];
}

function versionMajor(requirement: string | null): number | null {
  const match = requirement?.match(/\d+/);
  return match ? Number(match[0]) : null;
}

function chooseRuntime(facts: RepoFacts): "node22" | "node24" | "node26" | "python3.13" {
  if (!facts.nodeRequirement && facts.pythonRequirement && !facts.inferredStartCommand?.match(/^(?:npm|pnpm|yarn|bun)/)) {
    return "python3.13";
  }
  const major = versionMajor(facts.nodeRequirement);
  if (major !== null && major <= 22) return "node22";
  if (major !== null && major >= 25) return "node26";
  return "node24";
}

async function runShell(sandbox: Sandbox, command: string): Promise<CommandObservation> {
  const result = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", command],
    cwd: REPO_DIR,
  });
  return {
    command,
    exitCode: result.exitCode,
    stdout: await result.stdout(),
    stderr: await result.stderr(),
  };
}

async function detectRequiredEnv(sandbox: Sandbox): Promise<string[]> {
  const command = [
    "grep -RInE",
    "--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=build --exclude-dir=.venv",
    "--include='*.js' --include='*.jsx' --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.cjs' --include='*.py'",
    "'process\\.env\\.|process\\.env\\[|getenv\\(|os\\.environ'",
    ". 2>/dev/null | head -c 200000 || true",
  ].join(" ");
  const scan = await runShell(sandbox, command);
  return parseEnvScanOutput(scan.stdout);
}

async function preparePackageManager(sandbox: Sandbox, facts: RepoFacts): Promise<void> {
  if (facts.packageManager === "pnpm" || facts.packageManager === "yarn") {
    await runShell(sandbox, "corepack enable >/dev/null 2>&1 || true");
  }
}

function pickInstallCommand(plan: ReadmePlan, facts: RepoFacts): string | null {
  if (plan.installCommand && isSafeOnboardingCommand(plan.installCommand)) return plan.installCommand;
  if (facts.inferredInstallCommand && isSafeOnboardingCommand(facts.inferredInstallCommand)) return facts.inferredInstallCommand;
  return null;
}

function pickStartCommand(plan: ReadmePlan, facts: RepoFacts): string | null {
  if (plan.startCommand && isSafeOnboardingCommand(plan.startCommand)) return plan.startCommand;
  if (facts.inferredStartCommand && isSafeOnboardingCommand(facts.inferredStartCommand)) return facts.inferredStartCommand;
  return null;
}

async function runReadmePreparation(sandbox: Sandbox, plan: ReadmePlan): Promise<void> {
  const preparation = plan.commands.filter((command) => /^(?:cp|copy|mkdir|touch)\s+/i.test(command) && isSafeOnboardingCommand(command));
  for (const command of preparation) await runShell(sandbox, command);
}

async function startApplication(sandbox: Sandbox, command: string): Promise<{ log: string; ports: number[] }> {
  await sandbox.writeFiles([
    {
      path: "/tmp/rod-start.sh",
      content: Buffer.from(`#!/usr/bin/env bash\nset -o pipefail\ncd ${REPO_DIR}\nexec ${command} > /tmp/rod-start.log 2>&1\n`),
      mode: 0o700,
    },
  ]);
  await sandbox.runCommand({
    cmd: "/tmp/rod-start.sh",
    cwd: REPO_DIR,
    detached: true,
    env: {
      HOST: "0.0.0.0",
      HOSTNAME: "0.0.0.0",
    },
  });
  await sandbox.runCommand("sleep", ["8"]);

  const portResult = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", "(ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || true) | grep -oE ':[0-9]{2,5}' | tr -d ':' | sort -n -u"],
  });
  const ports = String(await portResult.stdout())
    .split(/\s+/)
    .map((value: string) => Number(value))
    .filter((port: number) => Number.isInteger(port) && port > 0 && port !== 23456);

  const logResult = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", "tail -c 20000 /tmp/rod-start.log 2>/dev/null || true"],
  });
  return { log: await logResult.stdout(), ports };
}

async function probeObservedUrl(sandbox: Sandbox, ports: number[]): Promise<{ url: string | null; status: number | null }> {
  const port = ports.find((candidate) => COMMON_PORTS.includes(candidate));
  if (!port) return { url: null, status: null };

  const domain = sandbox.domain(port);
  const url = domain.startsWith("http://") || domain.startsWith("https://") ? domain : `https://${domain}`;
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    return { url, status: response.status };
  } catch {
    return { url, status: null };
  }
}

export async function runSandboxDiagnosis(
  archive: Buffer,
  plan: ReadmePlan,
  facts: RepoFacts,
): Promise<SandboxDiagnosisResult> {
  const sandbox = await Sandbox.create({
    runtime: chooseRuntime(facts),
    timeout: 10 * 60 * 1000,
    ports: COMMON_PORTS,
    env: {
      CI: "1",
      ROD_SANDBOX: "1",
    },
  });

  try {
    await sandbox.writeFiles([{ path: ARCHIVE_PATH, content: archive, mode: 0o600 }]);
    const extract = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", `mkdir -p ${REPO_DIR} && tar -xzf ${ARCHIVE_PATH} -C ${REPO_DIR} --strip-components=1`],
    });
    if (extract.exitCode !== 0) {
      throw new Error(`Could not extract repository archive: ${await extract.stderr()}`);
    }

    const requiredEnv = await detectRequiredEnv(sandbox);
    await runReadmePreparation(sandbox, plan);
    await preparePackageManager(sandbox, facts);

    const installCommand = pickInstallCommand(plan, facts);
    const install = installCommand ? await runShell(sandbox, installCommand) : null;
    const startCommand = pickStartCommand(plan, facts);

    let startLog = "";
    let observedPorts: number[] = [];
    let observedUrl: string | null = null;
    let httpStatus: number | null = null;

    if (startCommand && (!install || install.exitCode === 0)) {
      const started = await startApplication(sandbox, startCommand);
      startLog = started.log;
      observedPorts = started.ports;
      const probe = await probeObservedUrl(sandbox, observedPorts);
      observedUrl = probe.url;
      httpStatus = probe.status;
    }

    return {
      requiredEnv,
      execution: {
        install,
        startCommand,
        startLog,
        observedPorts,
        observedUrl,
        httpStatus,
      },
    };
  } finally {
    await sandbox.stop();
  }
}
