import assert from "node:assert/strict";
import test from "node:test";
import type { Octokit } from "octokit";
import { renderReport, upsertPullRequestReport } from "../lib/github/reporter";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const ROD_APP_ID = 101;
const OTHER_APP_ID = 202;

type FakeComment = {
  id: number;
  body: string;
  performed_via_github_app?: { id: number } | null;
};

class FakeOctokit {
  head = OLD_SHA;
  comments: FakeComment[];
  deleted: number[] = [];
  patched: number[] = [];
  private nextId = 100;

  constructor(
    comments: FakeComment[] = [],
    private readonly flipAfter: "patch" | "create" | null = null,
  ) {
    this.comments = comments.map((comment) => ({ ...comment }));
  }

  async paginate(): Promise<FakeComment[]> {
    return this.comments.map((comment) => ({
      ...comment,
      performed_via_github_app: comment.performed_via_github_app
        ? { ...comment.performed_via_github_app }
        : comment.performed_via_github_app,
    }));
  }

  async request(route: string, args: Record<string, unknown>): Promise<{ data: unknown }> {
    if (route.startsWith("GET /repos/{owner}/{repo}/pulls/")) {
      return { data: { head: { sha: this.head } } };
    }

    if (route.startsWith("PATCH /repos/{owner}/{repo}/issues/comments/")) {
      const id = Number(args.comment_id);
      const comment = this.comments.find((item) => item.id === id);
      if (comment) comment.body = String(args.body);
      this.patched.push(id);
      if (this.flipAfter === "patch") this.head = NEW_SHA;
      return { data: comment ?? {} };
    }

    if (route.startsWith("POST /repos/{owner}/{repo}/issues/")) {
      const comment: FakeComment = {
        id: this.nextId++,
        body: String(args.body),
        performed_via_github_app: { id: ROD_APP_ID },
      };
      this.comments.push(comment);
      if (this.flipAfter === "create") this.head = NEW_SHA;
      return { data: comment };
    }

    if (route.startsWith("DELETE /repos/{owner}/{repo}/issues/comments/")) {
      const id = Number(args.comment_id);
      this.deleted.push(id);
      this.comments = this.comments.filter((item) => item.id !== id);
      return { data: {} };
    }

    throw new Error(`Unexpected route: ${route}`);
  }
}

function rodComment(id: number, body: string): FakeComment {
  return { id, body, performed_via_github_app: { id: ROD_APP_ID } };
}

async function publish(octokit: FakeOctokit, report: string) {
  return upsertPullRequestReport(
    octokit as unknown as Octokit,
    "owner",
    "repo",
    1,
    OLD_SHA,
    ROD_APP_ID,
    report,
  );
}

for (const flipAfter of ["patch", "create"] as const) {
  test(`removes stale ROD report when PR head changes immediately after ${flipAfter}`, async () => {
    const initial = flipAfter === "patch"
      ? [rodComment(1, `<!-- rod-report -->\n<!-- rod-head:${OLD_SHA} -->\nold report`)]
      : [];
    const octokit = new FakeOctokit(initial, flipAfter);
    const report = renderReport([], null, OLD_SHA, null);
    const result = await publish(octokit, report);

    assert.equal(result.updated, false);
    assert.equal(result.currentHeadSha, NEW_SHA);
    assert.equal(octokit.comments.some((comment) => comment.body === report), false);
    assert(octokit.deleted.length > 0);
  });
}

test("ignores a user comment that spoofs the ROD marker", async () => {
  const spoof = { id: 1, body: `<!-- rod-report -->\n<!-- rod-head:${OLD_SHA} -->\nuser text`, performed_via_github_app: null };
  const octokit = new FakeOctokit([spoof]);
  const report = renderReport([], null, OLD_SHA, null);
  const result = await publish(octokit, report);

  assert.equal(result.updated, true);
  assert.equal(octokit.comments.some((comment) => comment.id === spoof.id), true);
  assert.equal(octokit.patched.includes(spoof.id), false);
  assert.equal(octokit.deleted.includes(spoof.id), false);
  assert(octokit.comments.some((comment) => comment.body === report && comment.performed_via_github_app?.id === ROD_APP_ID));
});

test("ignores another GitHub App that spoofs the ROD marker", async () => {
  const spoof: FakeComment = {
    id: 2,
    body: `<!-- rod-report -->\n<!-- rod-head:${OLD_SHA} -->\nother bot`,
    performed_via_github_app: { id: OTHER_APP_ID },
  };
  const octokit = new FakeOctokit([spoof]);
  const report = renderReport([], null, OLD_SHA, null);
  await publish(octokit, report);

  assert.equal(octokit.patched.includes(spoof.id), false);
  assert.equal(octokit.deleted.includes(spoof.id), false);
});

test("patches a marker comment created by the ROD GitHub App", async () => {
  const original = rodComment(3, `<!-- rod-report -->\n<!-- rod-head:${OLD_SHA} -->\nold`);
  const octokit = new FakeOctokit([original]);
  const report = renderReport([], null, OLD_SHA, null);
  const result = await publish(octokit, report);

  assert.equal(result.updated, true);
  assert.deepEqual(octokit.patched, [original.id]);
  assert.equal(octokit.comments.find((comment) => comment.id === original.id)?.body, report);
});

test("never deletes a user comment even when it carries the current rod-head marker", async () => {
  const canonical = rodComment(4, `<!-- rod-report -->\n<!-- rod-head:${OLD_SHA} -->\nold`);
  const userSpoof: FakeComment = {
    id: 5,
    body: `<!-- rod-report -->\n<!-- rod-head:${OLD_SHA} -->\ndo not delete me`,
    performed_via_github_app: null,
  };
  const duplicate = rodComment(6, `<!-- rod-report -->\n<!-- rod-head:${OLD_SHA} -->\nduplicate`);
  const octokit = new FakeOctokit([canonical, userSpoof, duplicate]);
  const report = renderReport([], null, OLD_SHA, null);
  await publish(octokit, report);

  assert.equal(octokit.deleted.includes(userSpoof.id), false);
  assert.equal(octokit.comments.some((comment) => comment.id === userSpoof.id), true);
  assert.equal(octokit.deleted.includes(duplicate.id), true);
});

test("uses a longer Markdown fence than any backtick run in untrusted evidence", () => {
  const report = renderReport([
    {
      code: "INSTALL_BROKEN",
      severity: "error",
      title: "Install failed",
      detail: "Untrusted output follows.",
      evidence: ["before\n```\n### injected heading\n````\nafter"],
    },
  ], null, OLD_SHA, null);

  assert(report.includes("`````text\nbefore"));
  assert(report.includes("after\n`````"));
});
