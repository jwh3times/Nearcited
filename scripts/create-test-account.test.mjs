import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestAccount, readSettings } from "./create-test-account.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const password = "a-long-enough-password-for-this";
const target = {
  supabaseUrl: "https://project.example",
  publishableKey: "sb_publishable",
  email: "smoke@nearcited.example",
};
const secrets = { secretKey: "sb_secret", password };

/** A fetch that records each call and answers from a list, in order. */
function fakeFetch(...answers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const answer = answers.shift() ?? { status: 500, body: null };
    return new Response(answer.body === null ? "" : JSON.stringify(answer.body), {
      status: answer.status,
    });
  };
  return { impl, calls };
}

test("reads where the account goes from the Worker's config, and what makes it from the environment", () => {
  const read = readSettings(
    {
      SUPABASE_SECRET_KEY: "sb_secret",
      TEST_ACCOUNT_EMAIL: " Smoke@Nearcited.example ",
      TEST_ACCOUNT_PASSWORD: password,
    },
    root,
  );
  assert.match(read.target.supabaseUrl, /^https:\/\//);
  assert.ok(read.target.publishableKey);
  assert.equal(read.target.email, "smoke@nearcited.example");
  // The secrets travel apart from everything that may be printed.
  assert.deepEqual(read.secrets, { secretKey: "sb_secret", password });
  assert.equal(JSON.stringify(read.target).includes(password), false);
});

test("lets the environment point it at another stack", () => {
  const read = readSettings(
    {
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_PUBLISHABLE_KEY: "local",
      SUPABASE_SECRET_KEY: "sb_secret",
      TEST_ACCOUNT_EMAIL: "smoke@nearcited.example",
      TEST_ACCOUNT_PASSWORD: password,
    },
    root,
  );
  assert.equal(read.target.supabaseUrl, "http://127.0.0.1:54321");
  assert.equal(read.target.publishableKey, "local");
});

test("refuses to run without its secrets, a real address, or a password worth having", () => {
  const good = {
    SUPABASE_SECRET_KEY: "s",
    TEST_ACCOUNT_EMAIL: "a@b.example",
    TEST_ACCOUNT_PASSWORD: password,
  };
  assert.throws(() => readSettings({}, root), /SUPABASE_SECRET_KEY, TEST_ACCOUNT_EMAIL/);
  assert.throws(() => readSettings({ ...good, TEST_ACCOUNT_EMAIL: "nope" }, root), /not an email/);
  assert.throws(
    () => readSettings({ ...good, TEST_ACCOUNT_PASSWORD: "short" }, root),
    /at least 20 characters/,
  );
});

test("creates the account already confirmed, then grants it the test role", async () => {
  const { impl, calls } = fakeFetch(
    { status: 200, body: { id: "user-1" } },
    { status: 201, body: null },
  );
  const result = await createTestAccount({ fetch: impl, target, secrets });
  assert.deepEqual(result, { userId: "user-1", created: true });

  assert.equal(calls[0].url, "https://project.example/auth/v1/admin/users");
  assert.deepEqual(calls[0].body, { email: target.email, password, email_confirm: true });
  assert.equal(calls[0].init.headers.Authorization, "Bearer sb_secret");

  assert.equal(calls[1].url, "https://project.example/rest/v1/platform_roles?on_conflict=user_id");
  assert.deepEqual(calls[1].body, { user_id: "user-1", role: "test" });
  assert.match(calls[1].init.headers.Prefer, /merge-duplicates/);
});

test("finds an account that is already there by signing in as it, and grants the role again", async () => {
  const { impl, calls } = fakeFetch(
    { status: 422, body: { msg: "A user with this email address has already been registered" } },
    { status: 200, body: { user: { id: "user-1" } } },
    { status: 201, body: null },
  );
  assert.deepEqual(await createTestAccount({ fetch: impl, target, secrets }), {
    userId: "user-1",
    created: false,
  });
  // Signing in uses the public key, as the app would, never the secret one.
  assert.match(calls[1].url, /grant_type=password/);
  assert.equal(calls[1].init.headers.Authorization, "Bearer sb_publishable");
  assert.deepEqual(calls[2].body, { user_id: "user-1", role: "test" });
});

test("says so when the account exists with another password, and grants nothing", async () => {
  const { impl, calls } = fakeFetch(
    { status: 422, body: { msg: "already been registered" } },
    { status: 400, body: { msg: "Invalid login credentials" } },
  );
  await assert.rejects(createTestAccount({ fetch: impl, target, secrets }), /another password/);
  assert.equal(calls.length, 2);
});

test("says so when the role cannot be granted", async () => {
  const { impl } = fakeFetch({ status: 200, body: { id: "user-1" } }, { status: 404, body: null });
  await assert.rejects(
    createTestAccount({ fetch: impl, target, secrets }),
    /migration been applied/,
  );
});
