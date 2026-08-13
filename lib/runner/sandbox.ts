import { Sandbox } from "@vercel/sandbox";
import { parseEnvScanOutput } from "../analyzer/env-scan";
import { isSafeOnboardingCommand } from "../analyzer/readme";
import { selectNodeSandboxRuntime, supportsPython313 } from "../analyzer/runtime";
import type { CommandObservation, ExecutionObservation, ReadmePlan, RepoFacts } from "../analyzer/types";

const REPO_DIR = "/vercel/sandbox/repo";
const ARCHIVE_PATH = "/vercel/sandbox/rod-repo.tar.gz";
const COMMON_PORTS = [3000, 3001, 4173, 5000, 5173, 8000, 8080];
const SANDBOX_TIMEOUT_MS = 240_000;
const INSTALL_TIMEOUT_SECONDS = 150;
const PREP_TIMEOUT_SECONDS = 20;
const PROBE_TIMEOUT_MS = 40_000;
const PROBE_INTERVAL_MS = 2_000;

export interface SandboxDiagnosisResult {
  execution: ExecutionObservation;
  requiredEnv: string[];
}

type SandboxRuntime = "node22" | "node24" | "node26" | "python3.13";

function chooseRuntime(facts: RepoFacts): { runtime: SandboxRuntime | null; issue: string | null } {
  const isPythonProject = ["pip", "poetry", "uv"].includes(facts.packageManager ?? "")
    || Boolean(facts.inferredStartCommand?.match(/^(?:python|python3|uvicorn|flask|poetry|uv)\b/));

  if (isPythonProject) {
    if (!supportsPython313(facts.pythonRequirement)) {
      return {
        runtime: null,
        issue: `Repository requires Python ${facts.pythonRequirement ?? "an unsupported version"}, while ROD currently provides Python 3.13 for execution.`,
      };
    }
    return { runtime: "python3.13", issue: null };
  }

  const runtime = selectNodeSandboxRuntime(facts.nodeRequirement);
  if (!runtime) {
    return {
      runtime: null,
      issue: `Repository requires Node.js ${facts.nodeRequirement ?? "an unsupported version"}, while ROD currently provides Node.js 22, 24, and 26.`,
    };
  }
  return { runtime, issue: null };
}

async function runShell(sandbox: Sandbox, command: string, timeoutSeconds: number): Promise<CommandObservation> {
  const result = await sandbox.runCommand({
    cmd: "timeout",
    args: ["--signal=TERM", "--kill-after=5s", `${timeoutSeconds}s`, "bash", "-lc", command],
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
  const scan = await runShell(sandbox, command, PREP_TIMEOUT_SECONDS);
  return parseEnvScanOutput(scan.stdout);
}

async function preparePackageManager(sandbox: Sandbox, facts: RepoFacts): Promise<void> {
  if (facts.packageManager === "pnpm" || facts.packageManager === "yarn") {
    await runShell(sandbox, "corepack enable >/dev/null 2>&1 || true", PREP_TIMEOUT_SECONDS);
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
  for (const command of preparation) await runShell(sandbox, command, PREP_TIMEOUT_SECONDS);
}

async function startApplication(sandbox: Sandbox, command: string): Promise<void> {
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
}

async function readListeningPorts(sandbox: Sandbox, exposedPorts: number[]): Promise<number[]> {
  const portResult = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", "(ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null || true) | grep -oE ':[0-9]{2,5}' | tr -d ':' | sort -n -u"],
  });
  const allowed = new Set(exposedPorts);
  return String(await portResult.stdout())
    .split(/\s+/)
    .map((value: string) => Number(value))
    .filter((port: number) => Number.isInteger(port) && allowed.has(port));
}

async function probeObservedUrl(
  sandbox: Sandbox,
  exposedPorts: number[],
  preferredPort: number | null,
): Promise<{ port: number; url: string; status: number } | null> {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  let lastServerError: { port: number; url: string; status: number } | null = null;
  while (Date.now() < deadline) {
    const listeners = await readListeningPorts(sandbox, exposedPorts);
    const ordered = [...new Set([
      ...(preferredPort && listeners.includes(preferredPort) ? [preferredPort] : []),
      ...listeners,
    ])];

    for (const port of ordered) {
      const domain = sandbox.domain(port);
      const url = domain.startsWith("http://") || domain.startsWith("https://") ? domain : `https://${domain}`;
      try {
        const response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
        });
        const observation = { port, url, status: response.status };
        if (response.status < 500) return observation;
        lastServerError = observation;
      } catch {
        // A listener without an HTTP response is not considered a reachable app.
      }
    }
    await sandbox.runCommand("sleep", [String(PROBE_INTERVAL_MS / 1000)]);
  }
  return lastServerError;
}

async function readStartLog(sandbox: Sandbox): Promise<string> {
  const logResult = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", "tail -c 20000 /tmp/rod-start.log 2>/dev/null || true"],
  });
  return await logResult.stdout();
}

function emptyExecution(runtimeIssue: string | null): ExecutionObservation {
  return {
    install: null,
    startCommand: null,
    startLog: "",
    observedPort: null,
    observedUrl: null,
    httpStatus: null,
    runtimeIssue,
  };
}

export async function runSandboxDiagnosis(
  archive: Buffer,
  plan: ReadmePlan,
  facts: RepoFacts,
): Promise<SandboxDiagnosisResult> {
  const selection = chooseRuntime(facts);
  const exposedPorts = [...new Set([
    ...COMMON_PORTS,
    ...(plan.expectedPort && plan.expectedPort > 0 && plan.expectedPort <= 65535 ? [plan.expectedPort] : []),
  ])];

  // Unsupported project runtimes get a static env scan only; repository setup/start commands are skipped.
  const sandbox = await Sandbox.create({
    runtime: selection.runtime ?? "node24",
    timeout: SANDBOX_TIMEOUT_MS,
    ports: exposedPorts,
    env: {
      CI: "1",
      ROD_SANDBOX: "1",
    },
  });

  try {
    await sandbox.writeFiles([{ path: ARCHIVE_PATH, content: archive, mode: 0o600 }]);
    const extract = await sandbox.runCommand({
      cmd: "timeout",
      args: ["--signal=TERM", "30s", "bash", "-lc", `mkdir -p ${REPO_DIR} && tar -xzf ${ARCHIVE_PATH} -C ${REPO_DIR} --strip-components=1`],
    });
    if (extract.exitCode !== 0) {
      throw new Error(`Could not extract repository archive: ${await extract.stderr()}`);
    }

    const requiredEnv = await detectRequiredEnv(sandbox);
    if (!selection.runtime) {
      return { requiredEnv, execution: emptyExecution(selection.issue) };
    }

    await runReadmePreparation(sandbox, plan);
    await preparePackageManager(sandbox, facts);

    const installCommand = pickInstallCommand(plan, facts);
    const install = installCommand ? await runShell(sandbox, installCommand, INSTALL_TIMEOUT_SECONDS) : null;
    const startCommand = pickStartCommand(plan, facts);

    let startLog = "";
    let observedPort: number | null = null;
    let observedUrl: string | null = null;
    let httpStatus: number | null = null;

    if (startCommand && (!install || install.exitCode === 0)) {
      await startApplication(sandbox, startCommand);
      const probe = await probeObservedUrl(sandbox, exposedPorts, plan.expectedPort);
      startLog = await readStartLog(sandbox);
      if (probe) {
        observedPort = probe.port;
        observedUrl = probe.url;
        httpStatus = probe.status;
      }
    }

    return {
      requiredEnv,
      execution: {
        install,
        startCommand,
        startLog,
        observedPort,
        observedUrl,
        httpStatus,
        runtimeIssue: null,
      },
    };
  } finally {
    await sandbox.stop();
  }
}
