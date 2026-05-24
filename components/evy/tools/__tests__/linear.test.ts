// components/evy/tools/__tests__/linear.test.ts
//
// Tests for the v2.7.2 Linear-tool family. Hermetic — every test
// swaps in a canned `fetchHttp` so the suite never reaches
// api.linear.app. The mock matches against the GraphQL query string
// to decide which canned response to return when a tool issues
// multiple chained queries (e.g. linear_create_issue does team
// lookup → issueCreate).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _resetDepsForTesting, _setDepsForTesting, linearTools } from "../linear";

afterEach(() => {
  _resetDepsForTesting();
  delete process.env.LINEAR_API_KEY;
});

async function callTool<T = Record<string, unknown>>(
  tool: { invoke: (args: Record<string, unknown>) => Promise<unknown> },
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await tool.invoke(args)) as T;
}

/** Build a canned `fetchHttp` that returns the first matching pair's body. */
function mockGql(
  routes: Array<{
    match: (body: { query: string; variables: Record<string, unknown> }) => boolean;
    response:
      | { ok: true; payload: unknown }
      | { ok: false; status: number; text: string; headers?: Record<string, string> };
  }>,
): {
  fetchHttp: NonNullable<Parameters<typeof _setDepsForTesting>[0]["fetchHttp"]>;
  calls: Array<{ url: string; body: { query: string; variables: Record<string, unknown> }; headers?: Record<string, string> }>;
} {
  const calls: Array<{ url: string; body: { query: string; variables: Record<string, unknown> }; headers?: Record<string, string> }> = [];
  const fetchHttp: NonNullable<Parameters<typeof _setDepsForTesting>[0]["fetchHttp"]> = async (
    url,
    opts,
  ) => {
    const body = JSON.parse(opts.body ?? "{}") as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({ url, body, headers: opts.headers });
    for (const r of routes) {
      if (r.match(body)) {
        if (r.response.ok) {
          return {
            ok: true,
            status: 200,
            latencyMs: 5,
            text: JSON.stringify({ data: r.response.payload }),
          };
        }
        return {
          ok: false,
          status: r.response.status,
          latencyMs: 5,
          text: r.response.text,
          headers: r.response.headers,
        };
      }
    }
    return {
      ok: false,
      status: 500,
      latencyMs: 5,
      text: `no mock matched: ${body.query.slice(0, 80)}`,
    };
  };
  return { fetchHttp, calls };
}

// ---------------------------------------------------------------------------
// linear_list_issues
// ---------------------------------------------------------------------------

describe("linear_list_issues", () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = "test-linear-key";
  });

  test("happy path — returns normalized issues with filter + auth header", async () => {
    const { fetchHttp, calls } = mockGql([
      {
        match: (b) => b.query.includes("query Issues"),
        response: {
          ok: true,
          payload: {
            issues: {
              nodes: [
                {
                  id: "uuid-1",
                  identifier: "ENG-101",
                  title: "Wire web tools",
                  priority: 2,
                  url: "https://linear.app/team/issue/ENG-101",
                  state: { name: "In Progress" },
                  assignee: { email: "jason@example.com", name: "Jason" },
                },
                {
                  id: "uuid-2",
                  identifier: "ENG-102",
                  title: "Update changelog",
                  priority: 3,
                  url: "https://linear.app/team/issue/ENG-102",
                  state: { name: "In Progress" },
                  assignee: null,
                },
              ],
            },
          },
        },
      },
    ]);
    _setDepsForTesting({ fetchHttp });
    const r = await callTool<{
      ok: boolean;
      count: number;
      filter: { team_key: string | null; state: string | null; assignee_email: string | null };
      issues: Array<{ identifier: string | null; title: string; state: string | null; assignee: { email: string | null } | null }>;
    }>(linearTools.linear_list_issues, {
      team_key: "ENG",
      state: "In Progress",
      assignee_email: "jason@example.com",
      limit: 50,
    });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    expect(r.filter.team_key).toBe("ENG");
    expect(r.filter.state).toBe("In Progress");
    expect(r.issues[0]!.identifier).toBe("ENG-101");
    expect(r.issues[0]!.title).toBe("Wire web tools");
    expect(r.issues[0]!.state).toBe("In Progress");
    expect(r.issues[0]!.assignee?.email).toBe("jason@example.com");
    expect(r.issues[1]!.assignee).toBeNull();
    // Wire-level checks: auth header (RAW key, no "Bearer") + variables.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.linear.app/graphql");
    expect(calls[0]!.headers?.["Authorization"]).toBe("test-linear-key");
    expect(calls[0]!.headers?.["Content-Type"]).toBe("application/json");
    expect(calls[0]!.body.variables.first).toBe(50);
    const filter = calls[0]!.body.variables.filter as Record<string, unknown>;
    expect(filter.team).toEqual({ key: { eq: "ENG" } });
    expect(filter.state).toEqual({ name: { eq: "In Progress" } });
    expect(filter.assignee).toEqual({ email: { eq: "jason@example.com" } });
  });

  test("missing LINEAR_API_KEY returns structured error with plist hint", async () => {
    delete process.env.LINEAR_API_KEY;
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(
      linearTools.linear_list_issues,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("LINEAR_API_KEY");
    expect(r.error).toContain("com.subctl.evy.plist");
  });

  test("4xx (e.g. 401 invalid key) returns structured error", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 401,
        latencyMs: 5,
        text: '{"error":"unauthorized"}',
      }),
    });
    const r = await callTool<{ ok: boolean; error: string; status: number }>(
      linearTools.linear_list_issues,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).toContain("HTTP 401");
  });

  test("rate limit (429) surfaces retry_after", async () => {
    _setDepsForTesting({
      fetchHttp: async () => ({
        ok: false,
        status: 429,
        latencyMs: 5,
        text: '{"error":"too many requests"}',
        headers: { "retry-after": "45" },
      }),
    });
    const r = await callTool<{ ok: boolean; status: number; retry_after: string | null; error: string }>(
      linearTools.linear_list_issues,
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.retry_after).toBe("45");
    expect(r.error).toContain("rate limited");
  });
});

// ---------------------------------------------------------------------------
// linear_search
// ---------------------------------------------------------------------------

describe("linear_search", () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = "test-linear-key";
  });

  test("happy path — search returns issues with normalized shape", async () => {
    const { fetchHttp, calls } = mockGql([
      {
        match: (b) => b.query.includes("searchIssues"),
        response: {
          ok: true,
          payload: {
            searchIssues: {
              nodes: [
                {
                  id: "uuid-3",
                  identifier: "ENG-200",
                  title: "Add web search master tool",
                  priority: 1,
                  url: "https://linear.app/team/issue/ENG-200",
                  state: { name: "Backlog" },
                  assignee: null,
                },
              ],
            },
          },
        },
      },
    ]);
    _setDepsForTesting({ fetchHttp });
    const r = await callTool<{
      ok: boolean;
      query: string;
      count: number;
      issues: Array<{ identifier: string | null; title: string }>;
    }>(linearTools.linear_search, { query: "web search" });
    expect(r.ok).toBe(true);
    expect(r.query).toBe("web search");
    expect(r.count).toBe(1);
    expect(r.issues[0]!.identifier).toBe("ENG-200");
    expect(calls[0]!.body.variables.term).toBe("web search");
  });

  test("empty query returns ok=false (no HTTP call)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(linearTools.linear_search, {
      query: "   ",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("query is required");
  });
});

// ---------------------------------------------------------------------------
// linear_create_issue (WRITE)
// ---------------------------------------------------------------------------

describe("linear_create_issue", () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = "test-linear-key";
  });

  test("happy path — resolves team key, then creates issue", async () => {
    const { fetchHttp, calls } = mockGql([
      {
        match: (b) => b.query.includes("query TeamByKey"),
        response: {
          ok: true,
          payload: {
            teams: { nodes: [{ id: "team-uuid", key: "ENG", name: "Engineering" }] },
          },
        },
      },
      {
        match: (b) => b.query.includes("mutation IssueCreate"),
        response: {
          ok: true,
          payload: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-uuid",
                identifier: "ENG-999",
                url: "https://linear.app/team/issue/ENG-999",
                title: "ship v2.7.2",
              },
            },
          },
        },
      },
    ]);
    _setDepsForTesting({ fetchHttp });
    const r = await callTool<{
      ok: boolean;
      issue: { id: string; identifier: string; url: string; title: string };
      team: { key: string; name: string };
    }>(linearTools.linear_create_issue, {
      team_key: "ENG",
      title: "ship v2.7.2",
      description: "Brave + Firecrawl + Linear tools.",
      priority: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.issue.identifier).toBe("ENG-999");
    expect(r.issue.url).toContain("ENG-999");
    expect(r.team.key).toBe("ENG");
    // Two calls in order: team lookup, then create. Verify mutation input.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.query).toContain("TeamByKey");
    expect(calls[1]!.body.query).toContain("IssueCreate");
    const input = calls[1]!.body.variables.input as Record<string, unknown>;
    expect(input.teamId).toBe("team-uuid");
    expect(input.title).toBe("ship v2.7.2");
    expect(input.description).toBe("Brave + Firecrawl + Linear tools.");
    expect(input.priority).toBe(1);
  });

  test("unknown team_key returns structured error (no create call)", async () => {
    const { fetchHttp, calls } = mockGql([
      {
        match: (b) => b.query.includes("query TeamByKey"),
        response: { ok: true, payload: { teams: { nodes: [] } } },
      },
    ]);
    _setDepsForTesting({ fetchHttp });
    const r = await callTool<{ ok: boolean; error: string }>(linearTools.linear_create_issue, {
      team_key: "NOPE",
      title: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("team");
    expect(r.error).toContain("NOPE");
    // Only the lookup ran — no mutation issued.
    expect(calls).toHaveLength(1);
  });

  test("missing required args returns ok=false (no HTTP call)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r1 = await callTool<{ ok: boolean; error: string }>(linearTools.linear_create_issue, {
      title: "x",
    });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("team_key");
    const r2 = await callTool<{ ok: boolean; error: string }>(linearTools.linear_create_issue, {
      team_key: "ENG",
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("title");
  });
});

// ---------------------------------------------------------------------------
// linear_update_issue (WRITE)
// ---------------------------------------------------------------------------

describe("linear_update_issue", () => {
  beforeEach(() => {
    process.env.LINEAR_API_KEY = "test-linear-key";
  });

  test("happy path — state change resolves identifier → state UUID → updates", async () => {
    const { fetchHttp, calls } = mockGql([
      {
        match: (b) => b.query.includes("query IssueLookup"),
        response: {
          ok: true,
          payload: {
            issue: {
              id: "issue-uuid",
              identifier: "ENG-101",
              team: { id: "team-uuid", key: "ENG" },
            },
          },
        },
      },
      {
        match: (b) => b.query.includes("query WorkflowStates"),
        response: {
          ok: true,
          payload: {
            workflowStates: {
              nodes: [{ id: "state-uuid", name: "Done", type: "completed" }],
            },
          },
        },
      },
      {
        match: (b) => b.query.includes("mutation IssueUpdate"),
        response: {
          ok: true,
          payload: {
            issueUpdate: {
              success: true,
              issue: {
                id: "issue-uuid",
                identifier: "ENG-101",
                url: "https://linear.app/team/issue/ENG-101",
                state: { name: "Done" },
              },
            },
          },
        },
      },
    ]);
    _setDepsForTesting({ fetchHttp });
    const r = await callTool<{
      ok: boolean;
      state_changed?: boolean;
      new_state?: string;
      issue: { id: string; identifier: string };
    }>(linearTools.linear_update_issue, { issue_id: "ENG-101", state: "Done" });
    expect(r.ok).toBe(true);
    expect(r.state_changed).toBe(true);
    expect(r.new_state).toBe("Done");
    expect(r.issue.identifier).toBe("ENG-101");
    // 3 calls in order: lookup, state lookup, update.
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body.variables.id).toBe("issue-uuid");
    const updateInput = calls[2]!.body.variables.input as Record<string, unknown>;
    expect(updateInput.stateId).toBe("state-uuid");
  });

  test("happy path — comment-only is a single mutation after lookup", async () => {
    const { fetchHttp, calls } = mockGql([
      {
        match: (b) => b.query.includes("query IssueLookup"),
        response: {
          ok: true,
          payload: {
            issue: {
              id: "issue-uuid",
              identifier: "ENG-101",
              team: { id: "team-uuid", key: "ENG" },
            },
          },
        },
      },
      {
        match: (b) => b.query.includes("mutation CommentCreate"),
        response: {
          ok: true,
          payload: {
            commentCreate: {
              success: true,
              comment: { id: "comment-uuid", url: "https://linear.app/comment/c1" },
            },
          },
        },
      },
    ]);
    _setDepsForTesting({ fetchHttp });
    const r = await callTool<{
      ok: boolean;
      comment_added?: boolean;
      comment?: { id: string; url: string };
    }>(linearTools.linear_update_issue, {
      issue_id: "ENG-101",
      comment: "Verified locally, marking done.",
    });
    expect(r.ok).toBe(true);
    expect(r.comment_added).toBe(true);
    expect(r.comment?.id).toBe("comment-uuid");
    // 2 calls: lookup + commentCreate. No workflowStates lookup.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.query).toContain("CommentCreate");
    const input = calls[1]!.body.variables.input as Record<string, unknown>;
    expect(input.issueId).toBe("issue-uuid");
    expect(input.body).toBe("Verified locally, marking done.");
  });

  test("neither state nor comment provided returns ok=false (no HTTP call)", async () => {
    _setDepsForTesting({
      fetchHttp: async () => {
        throw new Error("must not be called");
      },
    });
    const r = await callTool<{ ok: boolean; error: string }>(linearTools.linear_update_issue, {
      issue_id: "ENG-101",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("at least one");
  });

  test("unknown state name returns structured error after state lookup", async () => {
    const { fetchHttp } = mockGql([
      {
        match: (b) => b.query.includes("query IssueLookup"),
        response: {
          ok: true,
          payload: {
            issue: {
              id: "issue-uuid",
              identifier: "ENG-101",
              team: { id: "team-uuid", key: "ENG" },
            },
          },
        },
      },
      {
        match: (b) => b.query.includes("query WorkflowStates"),
        response: { ok: true, payload: { workflowStates: { nodes: [] } } },
      },
    ]);
    _setDepsForTesting({ fetchHttp });
    const r = await callTool<{ ok: boolean; error: string }>(linearTools.linear_update_issue, {
      issue_id: "ENG-101",
      state: "Donezo",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("workflow state");
    expect(r.error).toContain("Donezo");
  });
});

// ---------------------------------------------------------------------------
// Family export sanity
// ---------------------------------------------------------------------------

describe("linearTools family export", () => {
  test("exports exactly the 4 v2.7.2 Linear tools", () => {
    expect(Object.keys(linearTools).sort()).toEqual([
      "linear_create_issue",
      "linear_list_issues",
      "linear_search",
      "linear_update_issue",
    ]);
    for (const [name, t] of Object.entries(linearTools)) {
      expect(typeof t.description, name).toBe("string");
      expect(t.description.length, name).toBeGreaterThan(20);
      expect(typeof t.schema, name).toBe("object");
      expect(typeof t.invoke, name).toBe("function");
    }
  });
});
