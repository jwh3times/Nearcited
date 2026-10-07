#!/usr/bin/env node
// Creates or revokes a shareable audit: a one-off report for a business that has not signed up.
//
//   npm run audit:create -- --name "Joe's Pizza" --city Raleigh --region NC \
//     --website joespizza.example --prompt "best pizza" --prompt "late night food"
//   npm run audit:revoke -- <link or token>
//
// Only the owner of the deployment can do this: it needs the Supabase secret key and a Cloudflare
// token, read from the environment and never from a file in this repository.
//
//   SUPABASE_SECRET_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
//
// Creating an audit inserts a row, then puts one message per prompt on the scan queue. The
// deployed Worker asks each prompt on every assistant, `--samples` times each, so an audit costs
// real money: prompts x samples x assistants answers.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_PROMPTS = 5;
export const MAX_SAMPLES = 5;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Removes comments and trailing commas from JSONC, leaving strings (and the URLs in them) alone. */
export function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Where the deployment lives, from the Worker's own config so the two cannot drift apart. */
export function readDeployment(root) {
  const file = join("apps", "api", "wrangler.jsonc");
  const config = JSON.parse(stripJsonc(readFileSync(join(root, file), "utf8")));
  const deployment = {
    supabaseUrl: config.vars?.SUPABASE_URL,
    appUrl: config.vars?.APP_URL,
    queue: config.queues?.producers?.[0]?.queue,
  };
  for (const [key, value] of Object.entries(deployment)) {
    if (typeof value !== "string" || !value) throw new Error(`${file} does not set ${key}.`);
  }
  return {
    ...deployment,
    supabaseUrl: deployment.supabaseUrl.replace(/\/+$/, ""),
    appUrl: deployment.appUrl.replace(/\/+$/, ""),
  };
}

const FLAGS = {
  "--name": "business_name",
  "--city": "city",
  "--region": "region",
  "--country": "country_code",
  "--website": "website",
  "--samples": "samples",
};

/** Turns the command line into a command: `create` with a row to insert, or `revoke` with a token. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === "revoke") {
    if (rest.length !== 1) throw new Error("Usage: audit:revoke -- <link or token>");
    // The token alone, or anywhere in a link's path.
    const token = /(?:^|\/)([0-9a-f]{64})(?:$|[/?#])/.exec(rest[0].trim())?.[1];
    if (!token) throw new Error("That is not an audit link or token.");
    return { command, token };
  }
  if (command !== "create") throw new Error('The first argument must be "create" or "revoke".');

  const given = { prompts: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1]?.trim();
    if (flag !== "--prompt" && !(flag in FLAGS)) throw new Error(`Unknown option ${flag}.`);
    if (!value) throw new Error(`${flag} needs a value.`);
    if (flag === "--prompt") given.prompts.push(value);
    else if (FLAGS[flag] in given) throw new Error(`${flag} was given twice.`);
    else given[FLAGS[flag]] = value;
  }
  return { command, audit: auditRow(given) };
}

function text(value, label, max, required) {
  if (value === undefined) {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }
  if (value.length > max) throw new Error(`${label} can be at most ${max} characters.`);
  return value;
}

/** Checks the values against the same limits the table has, so a mistake fails here, with words. */
export function auditRow(given) {
  const prompts = given.prompts ?? [];
  if (prompts.length < 1 || prompts.length > MAX_PROMPTS) {
    throw new Error(`Give between 1 and ${MAX_PROMPTS} prompts, each with --prompt.`);
  }
  if (new Set(prompts.map((prompt) => prompt.toLowerCase())).size !== prompts.length) {
    throw new Error("Two prompts are the same.");
  }
  for (const prompt of prompts) text(prompt, "A prompt", 200, true);

  const samples = given.samples === undefined ? MAX_SAMPLES : Number(given.samples);
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) {
    throw new Error(`--samples must be a whole number from 1 to ${MAX_SAMPLES}.`);
  }

  const country = (given.country_code ?? "US").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("--country must be a two-letter code.");

  let website = text(given.website, "--website", 200, false);
  if (website) {
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;
    let host = "";
    try {
      host = new URL(website).hostname;
    } catch {}
    if (!host.includes(".")) throw new Error("--website is not a web address.");
  }

  return {
    business_name: text(given.business_name, "--name", 120, true),
    website,
    city: text(given.city, "--city", 80, true),
    region: text(given.region, "--region", 80, false),
    country_code: country,
    prompts,
    samples,
  };
}

export function readSecrets(env) {
  const secrets = {
    supabaseKey: env.SUPABASE_SECRET_KEY,
    cloudflareToken: env.CLOUDFLARE_API_TOKEN,
    cloudflareAccount: env.CLOUDFLARE_ACCOUNT_ID,
  };
  const missing = [
    !secrets.supabaseKey && "SUPABASE_SECRET_KEY",
    !secrets.cloudflareToken && "CLOUDFLARE_API_TOKEN",
    !secrets.cloudflareAccount && "CLOUDFLARE_ACCOUNT_ID",
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`Set ${missing.join(", ")} in the environment.`);
  return secrets;
}

async function supabase(ctx, method, query, body) {
  const response = await ctx.fetch(`${ctx.deployment.supabaseUrl}/rest/v1/audits${query}`, {
    method,
    headers: {
      apikey: ctx.secrets.supabaseKey,
      Authorization: `Bearer ${ctx.secrets.supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Supabase answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  return response.json();
}

async function cloudflare(ctx, method, path, body) {
  const response = await ctx.fetch(
    `${CLOUDFLARE_API}/accounts/${ctx.secrets.cloudflareAccount}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${ctx.secrets.cloudflareToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const reason = payload?.errors?.map((error) => error.message).join("; ");
    throw new Error(`Cloudflare answered ${response.status}${reason ? `: ${reason}` : ""}`);
  }
  return payload.result;
}

/**
 * Inserts the audit and queues one message per prompt. If queueing fails, the audit is marked
 * failed, so the link never shows a report that is waiting for work nobody was asked to do.
 */
export async function createAudit(ctx, audit) {
  const [row] = await supabase(ctx, "POST", "?select=id,token,expires_at", audit);
  try {
    const queues = await cloudflare(ctx, "GET", "/queues");
    const queue = queues.find((candidate) => candidate.queue_name === ctx.deployment.queue);
    if (!queue) throw new Error(`There is no queue named ${ctx.deployment.queue}.`);
    await cloudflare(ctx, "POST", `/queues/${queue.queue_id}/messages/batch`, {
      messages: audit.prompts.map((_, prompt_index) => ({
        body: { audit_id: row.id, prompt_index },
        content_type: "json",
      })),
    });
  } catch (error) {
    await supabase(ctx, "PATCH", `?id=eq.${row.id}`, {
      status: "failed",
      error: `Could not be queued: ${error.message}`.slice(0, 500),
    }).catch(() => {});
    throw error;
  }
  return { link: `${ctx.deployment.appUrl}/audit/${row.token}`, expires_at: row.expires_at };
}

/** Withdraws a link. Returns false when no audit has that token. */
export async function revokeAudit(ctx, token, now = new Date()) {
  const rows = await supabase(ctx, "PATCH", `?token=eq.${token}&select=id`, {
    revoked_at: now.toISOString(),
  });
  return rows.length > 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const ctx = { fetch, deployment: readDeployment(root), secrets: readSecrets(process.env) };
    if (parsed.command === "revoke") {
      console.log(
        (await revokeAudit(ctx, parsed.token))
          ? "Revoked. The link now says the report is no longer available."
          : "No audit has that token.",
      );
    } else {
      const { prompts, samples } = parsed.audit;
      const { link, expires_at } = await createAudit(ctx, parsed.audit);
      console.log(link);
      console.log(
        `${prompts.length} prompt${prompts.length === 1 ? "" : "s"}, asked ${samples} times on each assistant. ` +
          `The page fills in over the next few minutes and works until ${expires_at.slice(0, 10)}.`,
      );
    }
  } catch (error) {
    console.error(`audit: ${error.message}`);
    process.exitCode = 1;
  }
}
