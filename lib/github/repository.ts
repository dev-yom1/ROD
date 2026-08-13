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

async function installationToken(octokit: Octokit): Promise<string> {
  const auth = (await octokit.auth()) as { token?: string };
  if (!auth.token) throw new Error("Could not obtain GitHub installation token");
  return auth.token;
}

function contentsUrl(owner: string, repo: string, path: string, ref: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`,
  );
  url.searchParams.set("ref", ref);
  return url.toString();
}

async function readTextFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const response = await fetch(contentsUrl(owner, repo, path, ref), {
    headers: {
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "repo-onboarding-doctor",
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub file read failed for ${path}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export async function fetchRepositoryMetadata(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<RepositorySnapshotMetadata> {
  const token = await installationToken(octokit);
  const [readmeUpper, readmeLower, packageJson, pyproject, nvmrc, nodeVersion, pythonVersion, envExample, envSample] = await Promise.all([
    readTextFile(token, owner, repo, "README.md", ref),
    readTextFile(token, owner, repo, "readme.md", ref),
    readTextFile(token, owner, repo, "package.json", ref),
    readTextFile(token, owner, repo, "pyproject.toml", ref),
    readTextFile(token, owner, repo, ".nvmrc", ref),
    readTextFile(token, owner, repo, ".node-version", ref),
    readTextFile(token, owner, repo, ".python-version", ref),
    readTextFile(token, owner, repo, ".env.example", ref),
    readTextFile(token, owner, repo, ".env.sample", ref),
  ]);

  const lockfileCandidates = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "uv.lock", "poetry.lock"];
  const lockfileResults = await Promise.all(
    lockfileCandidates.map(async (path) => ({ path, exists: (await readTextFile(token, owner, repo, path, ref)) !== null })),
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
  const token = await installationToken(octokit);
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(ref)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "repo-onboarding-doctor",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`GitHub archive download failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}
