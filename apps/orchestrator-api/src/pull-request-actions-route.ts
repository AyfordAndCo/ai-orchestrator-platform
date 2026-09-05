import {
  listPullRequestActions,
  type PullRequestActionSource,
} from "../../../packages/domain/src/pull-request-actions/index.js";

export interface ApiRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const jsonHeaders = Object.freeze({
  "content-type": "application/json; charset=utf-8",
});

function jsonResponse(status: number, body: unknown): ApiResponse {
  return { status, headers: jsonHeaders, body: JSON.stringify(body) };
}

export function createPullRequestActionsRoute(
  source: PullRequestActionSource,
  clock: () => Date = () => new Date(),
): (request: ApiRequest) => Promise<ApiResponse> {
  return async (request) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/pull-requests/actions") {
      return jsonResponse(404, {
        error: { code: "not_found", message: "Resource not found" },
      });
    }
    if (request.method !== "GET") {
      return {
        ...jsonResponse(405, {
          error: { code: "method_not_allowed", message: "Method not allowed" },
        }),
        headers: { ...jsonHeaders, allow: "GET" },
      };
    }
    try {
      return jsonResponse(200, {
        data: await listPullRequestActions(source, clock),
      });
    } catch {
      return jsonResponse(502, {
        error: {
          code: "github_unavailable",
          message: "Pull request data is temporarily unavailable",
        },
      });
    }
  };
}
