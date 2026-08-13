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

async function readTextFile(octokit: Octokit, owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
    });
    const data = response.data as { type?: string; content?: string; encoding?: string };
    if (data.type !== "file" || !data.content) return null;
    if (data.encoding === "base64") return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
    return data.content;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return null;
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
  const auth = (await octokit.auth()) as { token?: string };
  if (!auth.token) throw new Error("Could not obtain GitHub installation token for archive download");

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(ref)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${auth.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "repo-onboarding-doctor",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`GitHub archive download failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}
