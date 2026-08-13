import assert from "node:assert/strict";
import test from "node:test";
import type { Octokit } from "octokit";
import { ensureCheckRun } from "../lib/github/check-run";

const SHA = "a".repeat(40);
const ROD_APP_ID = 42;
const RUN_ID = "wrun_test_123";

class FakeOctokit {
  checkRuns: Array<{
    id: number;
    external_id: string;
    app: { id: number };
  }> = [];
  created = 0;

  async request(route: string, args: Record<string, unknown>): Promise<{ data: unknown }> {
    if (route.startsWith("GET /repos/{owner}/{repo}/commits/")) {
      return { data: { check_runs: this.checkRuns } };
    }

    if (route === "POST /repos/{owner}/{repo}/check-runs") {
      this.created += 1;
      const checkRun = {
        id: 100 + this.created,
        external_id: String(args.external_id),
        app: { id: ROD_APP_ID },
      };
      this.checkRuns.push(checkRun);
      return { data: checkRun };
    }

    throw new Error(`Unexpected route: ${route}`);
  }
}

test("reuses the ROD Check Run when the same Workflow step retries", async () => {
  const octokit = new FakeOctokit();
  octokit.checkRuns.push({
    id: 7,
    external_id: `rod:workflow:${RUN_ID}:pr:3`,
    app: { id: ROD_APP_ID },
  });

  const id = await ensureCheckRun(
    octokit as unknown as Octokit,
    "owner",
    "repo",
    3,
    SHA,
    ROD_APP_ID,
    RUN_ID,
  );

  assert.equal(id, 7);
  assert.equal(octokit.created, 0);
});

test("a separate Workflow run does not share the previous run's Check Run", async () => {
  const octokit = new FakeOctokit();
  octokit.checkRuns.push({
    id: 8,
    external_id: `rod:workflow:${RUN_ID}:pr:3`,
    app: { id: ROD_APP_ID },
  });

  const id = await ensureCheckRun(
    octokit as unknown as Octokit,
    "owner",
    "repo",
    3,
    SHA,
    ROD_APP_ID,
    "wrun_other_456",
  );

  assert.equal(id, 101);
  assert.equal(octokit.created, 1);
});

test("does not reuse a Check Run created by another GitHub App", async () => {
  const octokit = new FakeOctokit();
  octokit.checkRuns.push({
    id: 9,
    external_id: `rod:workflow:${RUN_ID}:pr:3`,
    app: { id: 999 },
  });

  const id = await ensureCheckRun(
    octokit as unknown as Octokit,
    "owner",
    "repo",
    3,
    SHA,
    ROD_APP_ID,
    RUN_ID,
  );

  assert.equal(id, 101);
  assert.equal(octokit.created, 1);
});
