import assert from "node:assert/strict";
import test from "node:test";
import type { Octokit } from "octokit";
import {
  ensureCheckRun,
  findWorkflowCheckRun,
  obsoleteWorkflowCheckIfPresent,
} from "../lib/github/check-run";

const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const ROD_APP_ID = 42;
const RUN_ID = "wrun_test_123";

class FakeOctokit {
  checkRuns: Array<{
    id: number;
    external_id: string;
    app: { id: number };
  }> = [];
  created = 0;
  paginateArgs: Record<string, unknown> | null = null;
  paginateMapProvided = false;
  patched: Array<Record<string, unknown>> = [];

  async paginate(
    route: string,
    args: Record<string, unknown>,
    map?: unknown,
  ): Promise<Array<{ id: number; external_id: string; app: { id: number } }>> {
    assert.equal(route, "GET /repos/{owner}/{repo}/commits/{ref}/check-runs");
    this.paginateArgs = { ...args };
    this.paginateMapProvided = typeof map === "function";
    return this.checkRuns.map((checkRun) => ({ ...checkRun }));
  }

  async request(route: string, args: Record<string, unknown>): Promise<{ data: unknown }> {
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

    if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
      this.patched.push({ ...args });
      return { data: { id: args.check_run_id } };
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

test("check lookup uses Octokit's normalized pagination array", async () => {
  const octokit = new FakeOctokit();
  octokit.checkRuns.push({
    id: 17,
    external_id: `rod:workflow:${RUN_ID}:pr:3`,
    app: { id: ROD_APP_ID },
  });

  const id = await findWorkflowCheckRun(
    octokit as unknown as Octokit,
    "owner",
    "repo",
    3,
    SHA,
    ROD_APP_ID,
    RUN_ID,
  );

  assert.equal(id, 17);
  assert.equal(octokit.paginateMapProvided, false);
  assert.equal(octokit.paginateArgs?.filter, "all");
  assert.equal(octokit.paginateArgs?.app_id, ROD_APP_ID);
  assert.equal(octokit.paginateArgs?.per_page, 100);
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

test("stale retry neutralizes a Check Run created by an earlier attempt", async () => {
  const octokit = new FakeOctokit();
  octokit.checkRuns.push({
    id: 27,
    external_id: `rod:workflow:${RUN_ID}:pr:3`,
    app: { id: ROD_APP_ID },
  });

  const settled = await obsoleteWorkflowCheckIfPresent(
    octokit as unknown as Octokit,
    "owner",
    "repo",
    3,
    SHA,
    ROD_APP_ID,
    RUN_ID,
    NEW_SHA,
  );

  assert.equal(settled, true);
  assert.equal(octokit.patched.length, 1);
  assert.equal(octokit.patched[0].check_run_id, 27);
  assert.equal(octokit.patched[0].status, "completed");
  assert.equal(octokit.patched[0].conclusion, "neutral");
  assert.match(
    String((octokit.patched[0].output as { summary: string }).summary),
    new RegExp(NEW_SHA.slice(0, 12)),
  );
});
