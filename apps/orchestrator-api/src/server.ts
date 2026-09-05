import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { PullRequestActionSource } from "../../../packages/domain/src/pull-request-actions/index.js";
import { GitHubPullRequestActionSource } from "../../../packages/integrations/src/github/pull-request-action-source.js";
import { createPullRequestActionsRoute } from "./pull-request-actions-route.js";

const securityHeaders = Object.freeze({
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

const staticFiles: Readonly<
  Record<string, { readonly path: string; readonly contentType: string }>
> = Object.freeze({
  "/": {
    path: "apps/dashboard-web/public/index.html",
    contentType: "text/html; charset=utf-8",
  },
  "/assets/styles.css": {
    path: "apps/dashboard-web/public/styles.css",
    contentType: "text/css; charset=utf-8",
  },
  "/assets/dashboard.js": {
    path: "dist/apps/dashboard-web/src/dashboard.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/assets/dashboard-model.js": {
    path: "dist/apps/dashboard-web/src/dashboard-model.js",
    contentType: "text/javascript; charset=utf-8",
  },
});

export function createOrchestratorApiServer(
  source: PullRequestActionSource,
  repositoryRoot: string = process.cwd(),
): Server {
  const actionRoute = createPullRequestActionsRoute(source);
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/pull-requests/actions") {
      const result = await actionRoute({
        method: request.method,
        url: request.url,
      });
      response.writeHead(result.status, {
        ...securityHeaders,
        ...result.headers,
        "cache-control": "no-store",
      });
      response.end(result.body);
      return;
    }
    if (path === "/favicon.ico") {
      response.writeHead(204, securityHeaders);
      response.end();
      return;
    }
    const asset = staticFiles[path];
    if (asset === undefined || request.method !== "GET") {
      response.writeHead(404, {
        ...securityHeaders,
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Not found");
      return;
    }
    try {
      const content = await readFile(resolve(repositoryRoot, asset.path));
      response.writeHead(200, {
        ...securityHeaders,
        "content-type": asset.contentType,
      });
      response.end(content);
    } catch {
      response.writeHead(500, {
        ...securityHeaders,
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Dashboard asset unavailable");
    }
  });
}

function startDefaultServer(): void {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("PORT must be an integer between 1 and 65535");
  }
  const source = new GitHubPullRequestActionSource({
    organization: process.env.GITHUB_ORGANIZATION ?? "AyfordAndCo",
    token: process.env.GITHUB_TOKEN ?? "",
  });
  createOrchestratorApiServer(source).listen(port, "127.0.0.1", () => {
    console.log(
      `Engineering Control Center listening on http://127.0.0.1:${port}`,
    );
  });
}

const invokedPath =
  process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) startDefaultServer();
