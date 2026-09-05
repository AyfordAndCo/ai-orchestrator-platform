import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const dashboardPath = new URL(
  "../../apps/dashboard-web/public/index.html",
  import.meta.url,
);

test("dashboard shell exposes accessible controls and live status", async () => {
  const html = await readFile(dashboardPath, "utf8");

  assert.match(html, /<main/);
  assert.match(html, /<nav[^>]+aria-label="Primary"/);
  assert.match(html, /<label[^>]+for="repository-filter"/);
  assert.match(html, /<label[^>]+for="action-filter"/);
  assert.match(html, /id="refresh-button"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<dialog[^>]+id="pr-detail"/);
});
