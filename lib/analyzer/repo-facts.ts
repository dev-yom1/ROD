import type { EnvTemplateName, PackageManager, RepoFacts } from "./types";

export interface RepoMetadataInput {
  packageJson: string | null;
  pyproject: string | null;
  nvmrc: string | null;
  nodeVersion: string | null;
  pythonVersion: string | null;
  lockfiles: string[];
  envExample: string | null;
  envSample?: string | null;
  requiredEnv?: string[];
}

interface PackageJsonShape {
  packageManager?: string;
  engines?: { node?: string };
  scripts?: Record<string, string>;
}

function safeJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function detectNodePackageManager(pkg: PackageJsonShape | null, lockfiles: string[]): PackageManager {
  if (!pkg) return null;
  const declared = pkg.packageManager?.split("@")[0];
  if (declared === "npm" || declared === "pnpm" || declared === "yarn" || declared === "bun") return declared;
  if (lockfiles.includes("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.includes("yarn.lock")) return "yarn";
  if (lockfiles.includes("bun.lock") || lockfiles.includes("bun.lockb")) return "bun";
  return "npm";
}

function detectPythonPackageManager(pyproject: string | null, lockfiles: string[]): PackageManager {
  if (!pyproject) return null;
  if (/\[tool\.poetry\]/.test(pyproject) || lockfiles.includes("poetry.lock")) return "poetry";
  if (/\[tool\.uv\]/.test(pyproject) || lockfiles.includes("uv.lock")) return "uv";
  return "pip";
}

function inferNodeInstallCommand(manager: PackageManager, lockfiles: string[]): string | null {
  if (!manager) return null;
  if (manager === "pnpm") return "pnpm install --frozen-lockfile";
  if (manager === "yarn") return "yarn install --immutable";
  if (manager === "bun") return "bun install --frozen-lockfile";
  return lockfiles.includes("package-lock.json") ? "npm ci" : "npm install";
}

function inferPythonInstallCommand(manager: PackageManager): string | null {
  if (manager === "poetry") return "poetry install";
  if (manager === "uv") return "uv sync";
  if (manager === "pip") return "python -m pip install -e .";
  return null;
}

function extractPythonRequirement(pyproject: string | null): string | null {
  return pyproject?.match(/requires-python\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
}

function parseEnvTemplate(text: string | null): string[] {
  if (!text) return [];
  const vars = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
    if (match) vars.add(match[1]);
  }
  return [...vars].sort();
}

export function buildRepoFacts(input: RepoMetadataInput): RepoFacts {
  const pkg = safeJson<PackageJsonShape>(input.packageJson);
  const nodePackageManager = detectNodePackageManager(pkg, input.lockfiles);
  const pythonPackageManager = detectPythonPackageManager(input.pyproject, input.lockfiles);
  const scripts = pkg?.scripts ?? {};
  const nodeManagerForScripts = nodePackageManager ?? "npm";
  const scriptCommand = (script: string) => `${nodeManagerForScripts}${nodeManagerForScripts === "npm" ? " run" : ""} ${script}`;
  const inferredNodeStartCommand = scripts.dev
    ? scriptCommand("dev")
    : scripts.start
      ? scriptCommand("start")
      : null;
  const inferredNodeInstallCommand = inferNodeInstallCommand(nodePackageManager, input.lockfiles);
  const inferredPythonInstallCommand = inferPythonInstallCommand(pythonPackageManager);
  const envFileVars: Partial<Record<EnvTemplateName, string[]>> = {
    ".env.example": parseEnvTemplate(input.envExample),
    ".env.sample": parseEnvTemplate(input.envSample ?? null),
  };

  return {
    packageManager: nodePackageManager ?? pythonPackageManager,
    nodePackageManager,
    pythonPackageManager,
    scripts,
    nodeRequirement: pkg?.engines?.node ?? null,
    nodePreferredVersion: input.nvmrc?.trim() || input.nodeVersion?.trim() || null,
    pythonRequirement: extractPythonRequirement(input.pyproject),
    pythonPreferredVersion: input.pythonVersion?.trim() || null,
    inferredNodeInstallCommand,
    inferredPythonInstallCommand,
    inferredNodeStartCommand,
    inferredInstallCommand: inferredNodeInstallCommand ?? inferredPythonInstallCommand,
    inferredStartCommand: inferredNodeStartCommand,
    requiredEnv: [...new Set(input.requiredEnv ?? [])].sort(),
    envExampleVars: envFileVars[".env.example"]?.length
      ? envFileVars[".env.example"]
      : (envFileVars[".env.sample"] ?? []),
    envFileVars,
  };
}
