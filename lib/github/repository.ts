import type { Octokit } from "octokit";

export interface RepositorySnapshotMetadata {
  readme: string;
  packageJson: string | null;
  pyproject: string | null;
  nvmrc: string | null;
  nodeVersion: string | null;
  pythonVersion: string | null;
  envExample: string | null;
  lockfiles: string[];
}

function textResponse(data: unknown, path: string): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  throw new Error(`GitHub raw file read returned an unexpected response for ${path}`);
}

async function readTextFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
      headers: {
        accept: "application/vnd.github.raw+json",
      },
    });
    return textResponse(response.data as unknown, path);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

export async function fetchRepositoryMetadata(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<RepositorySnapshotMetadata> {
  const [readmeUpper, readmeLower, packageJson, pyproject, nvmrc, nodeVersion, pythonVersion, envExample, envSample] = await Promise.all([
    readTextFile(octokit, owner, repo, "README.md", ref),
    readTextFile(octokit, owner, repo, "readme.md", ref),
    readTextFile(octokit, owner, repo, "package.json", ref),
    readTextFile(octokit, owner, repo, "pyproject.toml", ref),
    readTextFile(octokit, owner, repo, ".nvmrc", ref),
    readTextFile(octokit, owner, repo, ".node-version", ref),
    readTextFile(octokit, owner, repo, ".python-version", ref),
    readTextFile(octokit, owner, repo, ".env.example", ref),
    readTextFile(octokit, owner, repo, ".env.sample", ref),
  ]);

  const lockfileCandidates = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "uv.lock", "poetry.lock"];
  const lockfileResults = await Promise.all(
    lockfileCandidates.map(async (path) => ({ path, exists: (await readTextFile(octokit, owner, repo, path, ref)) !== null })),
  );

  return {
    readme: readmeUpper ?? readmeLower ?? "",
    packageJson,
    pyproject,
    nvmrc,
    nodeVersion,
    pythonVersion,
    envExample: envExample ?? envSample,
    lockfiles: lockfileResults.filter((item) => item.exists).map((item) => item.path),
  };
}

export async function downloadRepositoryArchive(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<Buffer> {
  const response = await octokit.request("GET /repos/{owner}/{repo}/tarball/{ref}", {
    owner,
    repo,
    ref,
    headers: {
      accept: "application/octet-stream",
    },
  });
  const data = response.data as unknown;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("GitHub archive download returned an unexpected response body");
}
