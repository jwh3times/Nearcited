import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditRow,
  createAudit,
  parseArgs,
  readDeployment,
  readSecrets,
  revokeAudit,
  stripJsonc,
} from "./create-audit.mjs";

const token = "ab".repeat(32);
const deployment = {
  supabaseUrl: "https://project.example",
  appUrl: "https://app.example",
  queue: "scans",
};
const secrets = { supabaseKey: "secret", cloudflareToken: "cf", cloudflareAccount: "acct" };

/** A fetch that records each call and answers from a list, in order. */
function fakeFetch(...answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected call to ${url}`);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  return { fetch, calls };
}

const create = (...extra) =>
  parseArgs([
    "create",
    "--name",
    "Joe's Pizza",
    "--city",
    "Raleigh",
    "--prompt",
    "best pizza",
    ...extra,
  ]);

test("strips comments and trailing commas without touching strings", () => {
  const parsed = JSON.parse(
    stripJsonc(
      '{\n  // a note\n  "url": "https://x.example/a//b", /* gone */\n  "list": [1, 2,],\n}',
    ),
  );
  assert.deepEqual(parsed, { url: "https://x.example/a//b", list: [1, 2] });
});

test("reads the deployment from the Worker's own config", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const found = readDeployment(root);
  assert.match(found.supabaseUrl, /^https:\/\/[^/]+$/);
  assert.match(found.appUrl, /^https:\/\/[^/]+$/);
  assert.ok(found.queue);
});

test("builds a row with the defaults the table has", () => {
  assert.deepEqual(create().audit, {
    business_name: "Joe's Pizza",
    website: null,
    city: "Raleigh",
    region: null,
    country_code: "US",
    prompts: ["best pizza"],
    samples: 5,
  });
});

test("takes every option, and several prompts in the order given", () => {
  const { audit } = create(
    "--prompt",
    "late night food",
    "--region",
    "NC",
    "--country",
    "ca",
    "--website",
    "joespizza.example",
    "--samples",
    "3",
  );
  assert.deepEqual(audit.prompts, ["best pizza", "late night food"]);
  assert.equal(audit.region, "NC");
  assert.equal(audit.country_code, "CA");
  assert.equal(audit.website, "https://joespizza.example");
  assert.equal(audit.samples, 3);
});

test("refuses what the table would refuse, in words", () => {
  assert.throws(
    () => parseArgs(["create", "--city", "Raleigh", "--prompt", "x"]),
    /--name is required/,
  );
  assert.throws(
    () => parseArgs(["create", "--name", "Joe's", "--prompt", "x"]),
    /--city is required/,
  );
  assert.throws(
    () => parseArgs(["create", "--name", "Joe's", "--city", "Raleigh"]),
    /between 1 and 5/,
  );
  assert.throws(
    () =>
      create("--prompt", "b", "--prompt", "c", "--prompt", "d", "--prompt", "e", "--prompt", "f"),
    /between 1 and 5/,
  );
  assert.throws(() => create("--prompt", "Best Pizza"), /the same/);
  assert.throws(() => create("--samples", "6"), /1 to 5/);
  assert.throws(() => create("--samples", "2.5"), /1 to 5/);
  assert.throws(() => create("--country", "USA"), /two-letter/);
  assert.throws(() => create("--website", "not a site"), /web address/);
  assert.throws(() => create("--name", "Other"), /given twice/);
  assert.throws(() => create("--colour", "red"), /Unknown option/);
  assert.throws(() => create("--region"), /needs a value/);
  assert.throws(
    () => auditRow({ business_name: "x".repeat(121), city: "y", prompts: ["z"] }),
    /120/,
  );
  assert.throws(() => parseArgs(["list"]), /create.*revoke/);
});

test("takes a link or a bare token to revoke", () => {
  assert.equal(parseArgs(["revoke", token]).token, token);
  assert.equal(parseArgs(["revoke", `https://app.example/audit/${token}`]).token, token);
  assert.equal(parseArgs(["revoke", `https://app.example/audit/${token}/?x=1`]).token, token);
  assert.throws(() => parseArgs(["revoke", "https://app.example/audit/nope"]), /not an audit link/);
  assert.throws(() => parseArgs(["revoke"]), /Usage/);
});

test("names every secret that is missing", () => {
  assert.throws(
    () => readSecrets({ CLOUDFLARE_API_TOKEN: "x" }),
    /SUPABASE_SECRET_KEY, CLOUDFLARE_ACCOUNT_ID/,
  );
  assert.deepEqual(
    readSecrets({
      SUPABASE_SECRET_KEY: "a",
      CLOUDFLARE_API_TOKEN: "b",
      CLOUDFLARE_ACCOUNT_ID: "c",
    }),
    { supabaseKey: "a", cloudflareToken: "b", cloudflareAccount: "c" },
  );
});

test("inserts the audit, queues one message per prompt and returns the link", async () => {
  const { audit } = create("--prompt", "late night food");
  const { fetch, calls } = fakeFetch(
    { body: [{ id: "audit-1", token, expires_at: "2026-11-06T00:00:00Z" }] },
    {
      body: {
        success: true,
        result: [
          { queue_id: "q0", queue_name: "other" },
          { queue_id: "q1", queue_name: "scans" },
        ],
      },
    },
    { body: { success: true, result: null } },
  );

  const made = await createAudit({ fetch, deployment, secrets }, audit);

  assert.deepEqual(made, {
    link: `https://app.example/audit/${token}`,
    expires_at: "2026-11-06T00:00:00Z",
  });
  assert.equal(calls[0].url, "https://project.example/rest/v1/audits?select=id,token,expires_at");
  assert.deepEqual(calls[0].body, audit);
  assert.match(calls[2].url, /\/accounts\/acct\/queues\/q1\/messages\/batch$/);
  assert.deepEqual(calls[2].body.messages, [
    { body: { audit_id: "audit-1", prompt_index: 0 }, content_type: "json" },
    { body: { audit_id: "audit-1", prompt_index: 1 }, content_type: "json" },
  ]);
});

test("marks the audit failed when it cannot be queued, so the link does not wait for ever", async () => {
  const { fetch, calls } = fakeFetch(
    { body: [{ id: "audit-1", token, expires_at: "2026-11-06T00:00:00Z" }] },
    { status: 403, body: { success: false, errors: [{ message: "Authentication error" }] } },
    { body: [] },
  );

  await assert.rejects(
    createAudit({ fetch, deployment, secrets }, create().audit),
    /Cloudflare answered 403: Authentication error/,
  );
  assert.equal(calls[2].method, "PATCH");
  assert.equal(calls[2].url, "https://project.example/rest/v1/audits?id=eq.audit-1");
  assert.equal(calls[2].body.status, "failed");
});

test("creates nothing on the queue when the insert is refused", async () => {
  const { fetch, calls } = fakeFetch({ status: 401, body: { message: "Invalid API key" } });
  await assert.rejects(
    createAudit({ fetch, deployment, secrets }, create().audit),
    /Supabase answered 401/,
  );
  assert.equal(calls.length, 1);
});

test("revokes by token and says whether there was one", async () => {
  const hit = fakeFetch({ body: [{ id: "audit-1" }] });
  const now = new Date("2026-10-07T12:00:00Z");
  assert.equal(await revokeAudit({ fetch: hit.fetch, deployment, secrets }, token, now), true);
  assert.equal(
    hit.calls[0].url,
    `https://project.example/rest/v1/audits?token=eq.${token}&select=id`,
  );
  assert.deepEqual(hit.calls[0].body, { revoked_at: "2026-10-07T12:00:00.000Z" });

  const miss = fakeFetch({ body: [] });
  assert.equal(await revokeAudit({ fetch: miss.fetch, deployment, secrets }, token), false);
});
