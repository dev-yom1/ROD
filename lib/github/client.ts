import { App, Octokit } from "octokit";
import { githubConfig } from "../config";

let app: App | null = null;

export function getGitHubApp(): App {
  if (!app) {
    const config = githubConfig();
    app = new App({
      appId: config.appId,
      privateKey: config.privateKey,
    });
  }
  return app;
}

export async function getInstallationOctokit(installationId: number): Promise<Octokit> {
  return (await getGitHubApp().getInstallationOctokit(installationId)) as Octokit;
}
