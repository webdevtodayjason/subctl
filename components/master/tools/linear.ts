// linear tools — Linear API issue management for the master daemon.
//
// Origin: 2026-05-12, same Telegram exchange that funded the web tools
// (Brave + Firecrawl). The operator runs subctl development out of
// Linear and the agent kept asking "is there an issue for this?" —
// the answer was always "ask the operator, I can't see it." After
// the web tools landed, the operator funded Linear API access and
// asked for four tools to close the loop: read issues, search them,
// create them, and update / comment on them. Same persistent-
// supervisor pattern as v2.7.1 (diag) and the web tools (Brave +
// Firecrawl): agent hits a capability gap, asks, capability ships.
//
// API: Linear's GraphQL endpoint at https://api.linear.app/graphql.
// Auth: `Authorization: <key>` — raw token, NO "Bearer" prefix (this
// trips people; Linear documents it explicitly). Content-Type
// application/json. Read paths use queries, mutate paths use
// mutations.
//
// Tool family:
//   linear_list_issues   — filter by team / state / assignee
//   linear_search        — text search across issue titles + bodies
//   linear_create_issue  — WRITE: create a new issue (only mutating
//                          read-path here; documented clearly)
//   linear_update_issue  — WRITE: change state and/or add a comment
//
// Same error semantics as the web family: missing key → structured
// error with plist hint, HTTP failure → structured error, 429 →
// retry_after surfaced, never throws.

// ─── injectable side-effect surface (for tests) ────────────────────────────

interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
  latencyMs: number;
  error?: string;
  /** Lower-cased header name → header value. */
  headers?: Record<string, string>;
}

interface Deps {
  fetchHttp: (
    url: string,
    opts: {
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
      timeoutMs: number;
    },
  ) => Promise<FetchResult>;
  now: () => number;
}

const realDeps: Deps = {
  fetchHttp: async (url, opts) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const text = await r.text();
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return {
        ok: r.ok,
        status: r.status,
        text,
        latencyMs: Date.now() - t0,
        headers,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "TimeoutError";
      return {
        ok: false,
        status: 0,
        text: "",
        latencyMs: Date.now() - t0,
        error: isAbort ? `timeout after ${opts.timeoutMs}ms` : msg,
      };
    }
  },
  now: () => Date.now(),
};

let deps: Deps = realDeps;

export function _setDepsForTesting(partial: Partial<Deps>): void {
  deps = { ...realDeps, ...partial };
}

export function _resetDepsForTesting(): void {
  deps = realDeps;
}

// ─── shared GraphQL helper ─────────────────────────────────────────────────

import { resolveSecret } from "../secrets";

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const QUERY_TIMEOUT_MS = 20_000;
const MUTATION_TIMEOUT_MS = 30_000;

// v2.7.4: hint mentions both paths (dashboard panel OR plist).
const KEY_MISSING_HINT =
  "Set it via the dashboard Settings → API Tokens panel (writes ~/.config/subctl/secrets.json, chmod 600) OR in ~/Library/LaunchAgents/com.subctl.master.plist EnvironmentVariables followed by `launchctl kickstart -k gui/$UID/com.subctl.master`.";

function requireApiKey(): { ok: true; key: string } | { ok: false; error: string } {
  // v2.7.4 priority chain: env > secrets.json > absent.
  const key = resolveSecret("linear_api_key");
  if (!key) {
    return {
      ok: false,
      error: `LINEAR_API_KEY not configured. ${KEY_MISSING_HINT}`,
    };
  }
  return { ok: true, key };
}

function bodyExcerpt(text: string, max = 400): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…(truncated ${trimmed.length - max} chars)`;
}

interface GraphQLResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
  retry_after?: string | null;
}

async function gql<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  timeoutMs: number,
): Promise<GraphQLResult<T>> {
  const r = await deps.fetchHttp(LINEAR_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: apiKey, // Linear: raw token, NO "Bearer" prefix
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    timeoutMs,
  });
  if (!r.ok) {
    if (r.status === 429) {
      const retry = r.headers?.["retry-after"];
      return {
        ok: false,
        error: `Linear rate limited (HTTP 429)${
          retry ? `, retry-after: ${retry}` : ""
        }. ${bodyExcerpt(r.text)}`,
        status: r.status,
        retry_after: retry ?? null,
      };
    }
    if (r.status === 0) {
      return { ok: false, error: `Linear network error: ${r.error ?? "unknown"}` };
    }
    return {
      ok: false,
      error: `Linear HTTP ${r.status}: ${bodyExcerpt(r.text)}`,
      status: r.status,
    };
  }
  let parsed: { data?: T; errors?: Array<{ message?: string }> };
  try {
    parsed = JSON.parse(r.text);
  } catch (err) {
    return {
      ok: false,
      error: `Linear response was not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (parsed.errors && parsed.errors.length > 0) {
    const msgs = parsed.errors.map((e) => e.message ?? "(no message)").join("; ");
    return { ok: false, error: `Linear GraphQL error: ${msgs}` };
  }
  if (!parsed.data) {
    return { ok: false, error: "Linear response missing data field" };
  }
  return { ok: true, data: parsed.data };
}

// ─── shared issue normalizer ───────────────────────────────────────────────

interface LinearIssueNode {
  id: string;
  identifier?: string;
  title?: string;
  priority?: number;
  url?: string;
  state?: { name?: string } | null;
  assignee?: { email?: string; name?: string } | null;
}

interface NormalizedIssue {
  id: string;
  identifier: string | null;
  title: string;
  state: string | null;
  assignee: { email: string | null; name: string | null } | null;
  priority: number | null;
  url: string | null;
}

function normalizeIssue(n: LinearIssueNode): NormalizedIssue {
  return {
    id: n.id,
    identifier: n.identifier ?? null,
    title: n.title ?? "",
    state: n.state?.name ?? null,
    assignee: n.assignee
      ? { email: n.assignee.email ?? null, name: n.assignee.name ?? null }
      : null,
    priority: typeof n.priority === "number" ? n.priority : null,
    url: n.url ?? null,
  };
}

// ─── tool 1: linear_list_issues ────────────────────────────────────────────

const LIST_ISSUES_QUERY = `
  query Issues($filter: IssueFilter, $first: Int) {
    issues(filter: $filter, first: $first) {
      nodes {
        id
        identifier
        title
        priority
        url
        state { name }
        assignee { email name }
      }
    }
  }
`;

const linear_list_issues = {
  description:
    "List Linear issues filtered by team key (e.g. 'ENG'), state name (e.g. 'In Progress'), and/or assignee email. Returns up to `limit` issues with identifier, title, state, assignee, priority, and url. Read-only.",
  schema: {
    type: "object",
    properties: {
      team_key: {
        type: "string",
        description: "Team key prefix, e.g. 'ENG' for ENG-123 issues.",
      },
      state: {
        type: "string",
        description: "State name to filter by (e.g. 'In Progress', 'Done').",
      },
      assignee_email: {
        type: "string",
        description: "Assignee email — exact match.",
      },
      limit: {
        type: "integer",
        description: "Max issues to return (default 25, max 100).",
        minimum: 1,
        maximum: 100,
      },
    },
    required: [],
  },
  invoke: async (
    args: {
      team_key?: string;
      state?: string;
      assignee_email?: string;
      limit?: number;
    } = {},
  ) => {
    const auth = requireApiKey();
    if (!auth.ok) return { ok: false, error: auth.error };
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
    const filter: Record<string, unknown> = {};
    if (args.team_key) filter.team = { key: { eq: args.team_key } };
    if (args.state) filter.state = { name: { eq: args.state } };
    if (args.assignee_email)
      filter.assignee = { email: { eq: args.assignee_email } };
    const r = await gql<{ issues: { nodes: LinearIssueNode[] } }>(
      auth.key,
      LIST_ISSUES_QUERY,
      { filter, first: limit },
      QUERY_TIMEOUT_MS,
    );
    if (!r.ok) return r;
    const nodes = r.data!.issues?.nodes ?? [];
    const issues = nodes.map(normalizeIssue);
    return {
      ok: true,
      count: issues.length,
      limit,
      filter: {
        team_key: args.team_key ?? null,
        state: args.state ?? null,
        assignee_email: args.assignee_email ?? null,
      },
      issues,
    };
  },
};

// ─── tool 2: linear_search ─────────────────────────────────────────────────

const SEARCH_QUERY = `
  query SearchIssues($term: String!, $first: Int) {
    searchIssues(term: $term, first: $first) {
      nodes {
        id
        identifier
        title
        priority
        url
        state { name }
        assignee { email name }
      }
    }
  }
`;

const linear_search = {
  description:
    "Full-text search across Linear issue titles and descriptions. Returns up to `limit` matching issues in the same shape as linear_list_issues. Read-only.",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search term." },
      limit: {
        type: "integer",
        description: "Max issues to return (default 25, max 100).",
        minimum: 1,
        maximum: 100,
      },
    },
    required: ["query"],
  },
  invoke: async (args: { query?: string; limit?: number } = {}) => {
    const term = typeof args.query === "string" ? args.query.trim() : "";
    if (!term) {
      return { ok: false, error: "query is required and must be a non-empty string" };
    }
    const auth = requireApiKey();
    if (!auth.ok) return { ok: false, error: auth.error };
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
    const r = await gql<{ searchIssues: { nodes: LinearIssueNode[] } }>(
      auth.key,
      SEARCH_QUERY,
      { term, first: limit },
      QUERY_TIMEOUT_MS,
    );
    if (!r.ok) return r;
    const nodes = r.data!.searchIssues?.nodes ?? [];
    const issues = nodes.map(normalizeIssue);
    return {
      ok: true,
      query: term,
      count: issues.length,
      limit,
      issues,
    };
  },
};

// ─── tool 3: linear_create_issue (WRITE) ───────────────────────────────────

const TEAM_BY_KEY_QUERY = `
  query TeamByKey($key: String!) {
    teams(filter: { key: { eq: $key } }, first: 1) {
      nodes { id key name }
    }
  }
`;

const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue { id identifier url title }
    }
  }
`;

const linear_create_issue = {
  description:
    "**WRITE** — create a new Linear issue. Required: team_key + title. Optional: description (markdown), priority (0=none, 1=urgent, 2=high, 3=normal, 4=low). This is the only mutating tool in the read-path Linear family alongside linear_update_issue — use deliberately.",
  schema: {
    type: "object",
    properties: {
      team_key: {
        type: "string",
        description: "Team key prefix, e.g. 'ENG'.",
      },
      title: { type: "string", description: "Issue title (required)." },
      description: {
        type: "string",
        description: "Issue body in markdown.",
      },
      priority: {
        type: "integer",
        description:
          "Priority — 0=none (default), 1=urgent, 2=high, 3=normal, 4=low.",
        minimum: 0,
        maximum: 4,
      },
    },
    required: ["team_key", "title"],
  },
  invoke: async (
    args: {
      team_key?: string;
      title?: string;
      description?: string;
      priority?: number;
    } = {},
  ) => {
    const teamKey = typeof args.team_key === "string" ? args.team_key.trim() : "";
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!teamKey) return { ok: false, error: "team_key is required" };
    if (!title) return { ok: false, error: "title is required" };
    const auth = requireApiKey();
    if (!auth.ok) return { ok: false, error: auth.error };
    // 1. Resolve team key → UUID. IssueCreateInput requires teamId.
    const teamR = await gql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
      auth.key,
      TEAM_BY_KEY_QUERY,
      { key: teamKey },
      QUERY_TIMEOUT_MS,
    );
    if (!teamR.ok) return teamR;
    const teamNode = teamR.data!.teams?.nodes?.[0];
    if (!teamNode) {
      return {
        ok: false,
        error: `Linear team with key '${teamKey}' not found. Verify the key in Linear's team settings.`,
      };
    }
    // 2. Create the issue.
    const input: Record<string, unknown> = { teamId: teamNode.id, title };
    if (typeof args.description === "string") input.description = args.description;
    if (typeof args.priority === "number") input.priority = args.priority;
    const createR = await gql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string; title: string } | null };
    }>(auth.key, ISSUE_CREATE_MUTATION, { input }, MUTATION_TIMEOUT_MS);
    if (!createR.ok) return createR;
    const result = createR.data!.issueCreate;
    if (!result.success || !result.issue) {
      return {
        ok: false,
        error: "Linear issueCreate returned success=false (no issue payload)",
      };
    }
    return {
      ok: true,
      issue: {
        id: result.issue.id,
        identifier: result.issue.identifier,
        url: result.issue.url,
        title: result.issue.title,
      },
      team: { key: teamNode.key, name: teamNode.name },
    };
  },
};

// ─── tool 4: linear_update_issue (WRITE) ───────────────────────────────────
//
// Supports two orthogonal updates, applied independently when both
// args are present:
//   - state: human-readable name → resolved to stateId via the
//            issue's team workflowStates query → issueUpdate.
//   - comment: markdown body → commentCreate (issueId required as UUID).
// Both paths share a single issue-lookup at the top to convert the
// `issue_id` arg (which may be either "ENG-123" or a raw UUID) into
// the UUID and the team's UUID we need for the state lookup.

const ISSUE_LOOKUP_QUERY = `
  query IssueLookup($id: String!) {
    issue(id: $id) {
      id
      identifier
      team { id key }
    }
  }
`;

const WORKFLOW_STATES_QUERY = `
  query WorkflowStates($teamId: ID!, $name: String!) {
    workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eq: $name } }, first: 1) {
      nodes { id name type }
    }
  }
`;

const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { id identifier url state { name } }
    }
  }
`;

const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { id url }
    }
  }
`;

const linear_update_issue = {
  description:
    "**WRITE** — change an issue's state and/or add a comment. issue_id accepts either an identifier ('ENG-123') or a UUID. At least one of `state` or `comment` must be provided. state is the human-readable name ('In Progress', 'Done') — the tool resolves it to the team's stateId. comment is a markdown body posted via commentCreate.",
  schema: {
    type: "object",
    properties: {
      issue_id: {
        type: "string",
        description: "Issue identifier ('ENG-123') or UUID.",
      },
      state: {
        type: "string",
        description: "Target state name (e.g. 'In Progress', 'Done').",
      },
      comment: {
        type: "string",
        description: "Markdown comment body to post on the issue.",
      },
    },
    required: ["issue_id"],
  },
  invoke: async (
    args: { issue_id?: string; state?: string; comment?: string } = {},
  ) => {
    const issueArg = typeof args.issue_id === "string" ? args.issue_id.trim() : "";
    if (!issueArg) return { ok: false, error: "issue_id is required" };
    const wantState = typeof args.state === "string" && args.state.trim().length > 0;
    const wantComment =
      typeof args.comment === "string" && args.comment.length > 0;
    if (!wantState && !wantComment) {
      return {
        ok: false,
        error: "linear_update_issue needs at least one of `state` or `comment`",
      };
    }
    const auth = requireApiKey();
    if (!auth.ok) return { ok: false, error: auth.error };
    // 1. Resolve issue. Linear's `issue(id)` accepts identifier OR UUID;
    //    we need the UUID for commentCreate.input.issueId and the team
    //    UUID for the workflowStates filter.
    const lookupR = await gql<{
      issue: { id: string; identifier: string; team: { id: string; key: string } } | null;
    }>(auth.key, ISSUE_LOOKUP_QUERY, { id: issueArg }, QUERY_TIMEOUT_MS);
    if (!lookupR.ok) return lookupR;
    const issueNode = lookupR.data!.issue;
    if (!issueNode) {
      return {
        ok: false,
        error: `Linear issue '${issueArg}' not found.`,
      };
    }
    const issueUuid = issueNode.id;
    const teamUuid = issueNode.team.id;
    const result: Record<string, unknown> = {
      ok: true,
      issue: { id: issueUuid, identifier: issueNode.identifier },
    };
    // 2. Optional state change.
    if (wantState) {
      const stateName = args.state!.trim();
      const wfR = await gql<{
        workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
      }>(
        auth.key,
        WORKFLOW_STATES_QUERY,
        { teamId: teamUuid, name: stateName },
        QUERY_TIMEOUT_MS,
      );
      if (!wfR.ok) return wfR;
      const stateNode = wfR.data!.workflowStates?.nodes?.[0];
      if (!stateNode) {
        return {
          ok: false,
          error: `Linear workflow state '${stateName}' not found in team '${issueNode.team.key}'. Check the state name (case + spelling).`,
        };
      }
      const updR = await gql<{
        issueUpdate: {
          success: boolean;
          issue: { id: string; identifier: string; url: string; state: { name: string } | null } | null;
        };
      }>(
        auth.key,
        ISSUE_UPDATE_MUTATION,
        { id: issueUuid, input: { stateId: stateNode.id } },
        MUTATION_TIMEOUT_MS,
      );
      if (!updR.ok) return updR;
      const upd = updR.data!.issueUpdate;
      if (!upd.success) {
        return { ok: false, error: "Linear issueUpdate returned success=false" };
      }
      result.state_changed = true;
      result.new_state = upd.issue?.state?.name ?? stateName;
    }
    // 3. Optional comment.
    if (wantComment) {
      const cmR = await gql<{
        commentCreate: { success: boolean; comment: { id: string; url: string } | null };
      }>(
        auth.key,
        COMMENT_CREATE_MUTATION,
        { input: { issueId: issueUuid, body: args.comment! } },
        MUTATION_TIMEOUT_MS,
      );
      if (!cmR.ok) return cmR;
      const cm = cmR.data!.commentCreate;
      if (!cm.success) {
        return { ok: false, error: "Linear commentCreate returned success=false" };
      }
      result.comment_added = true;
      result.comment = cm.comment;
    }
    return result;
  },
};

// ─── family export ──────────────────────────────────────────────────────────

export const linearTools = {
  linear_list_issues,
  linear_search,
  linear_create_issue,
  linear_update_issue,
};
