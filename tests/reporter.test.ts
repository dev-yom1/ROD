import assert from "node:assert/strict";
import test from "node:test";
import type { Octokit } from "octokit";
import { renderReport, upsertPullRequestReport } from "../lib/github/reporter";

const OLD_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

class FakeOctokit {
  head = OLD_SHA;
  comments: Array<{ id: number; body: string }>;
  deleted: number[] = [];
  private nextId = 2;

  constructor(private readonly flipAfter: "patch" | "create") {
    this.comments = flipAfter === "patch"
      ? [{ id: 1, body: "<!-- rod-report -->\nold report" }]
      : [];
  }

  async paginate(): Promise<Array<{ id: number; body: string }>> {
    return this.comments.map((comment) => ({ ...comment }));
  }

  async request(route: string, args: Record<string, unknown>): Promise<{ data: unknown }> {
    if (route.startsWith("GET /repos/{owner}/{repo}/pulls/")) {
      return { data: { head: { sha: this.head } } };
    }

    if (route.startsWith("PATCH /repos/{owner}/{repo}/issues/comments/")) {
      const id = Number(args.comment_id);
      const comment = this.comments.find((item) => item.id === id);
      if (comment) comment.body = String(args.body);
      if (this.flipAfter === "patch") this.head = NEW_SHA;
      return { data: comment ?? {} };
    }

    if (route.startsWith("POST /repos/{owner}/{repo}/issues/")) {
      const comment = { id: this.nextId++, body: String(args.body) };
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

for (const flipAfter of ["patch", "create"] as const) {
  test(`removes stale report when PR head changes immediately after ${flipAfter}`, async () => {
    const octokit = new FakeOctokit(flipAfter);
    const report = renderReport([], null, OLD_SHA, null);
    const result = await upsertPullRequestReport(
      octokit as unknown as Octokit,
      "owner",
      "repo",
      1,
      OLD_SHA,
      report,
    );

    assert.equal(result.updated, false);
    assert.equal(result.currentHeadSha, NEW_SHA);
    assert.equal(octokit.comments.some((comment) => comment.body === report), false);
    assert(octokit.deleted.length > 0);
  });
}
