import {
  FOUND_ANSWER_LABELS,
  FOUND_ASSISTANT_LABELS,
  FOUND_ASSISTANTS,
  type FoundMessage,
  FoundMessageSchema,
  readTap,
  tapValue,
} from "@nearcited/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { askingKeys, type FoundLink } from "./actions/review-requests";
import type { AppEnv } from "./app";
import type { Store } from "./store/types";

/**
 * "How did you find us?" on the way from a review request to the review form (issue #148,
 * `docs/adr/0033-a-found-answer-is-counted-on-the-way-to-the-review-form.md`).
 *
 * The link in a request is `/r/<token>`, signed, carrying the request's action, the review form
 * and the business's name. Its route has no sign-in and reads nothing: it checks the signature,
 * makes the page from the link alone, queues the worker and sends every tap on to the review form.
 * Only the worker counts, and it counts the first answer for a request and no other.
 */

/** Neither page is kept, indexed or framed, says where it came from, or runs anything. */
const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
  // Inline style and nothing else; the form posts here and goes on to the review site.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'",
} as const;

const escaped = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STYLE = `
body{margin:0;font:17px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#1c1c1c}
main{max-width:30rem;margin:0 auto;padding:2rem 1rem}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 1.25rem}
form{display:grid;gap:.6rem}
button{font:inherit;width:100%;padding:.8rem 1rem;border:1px solid #9a9a9a;border-radius:.5rem;background:#fff;color:inherit;text-align:left;cursor:pointer}
.which{display:flex;flex-wrap:wrap;gap:.4rem;margin:-.2rem 0 .3rem 1rem;align-items:center;font-size:.9rem}
.which button{width:auto;padding:.35rem .7rem;font-size:.9rem}
.note{margin-top:1.5rem;font-size:.85rem;color:#555}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}button{background:#151515;border-color:#777}.note{color:#aaa}}
`;

const page = (title: string, body: string) =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;

const button = (value: string, label: string) =>
  `<button type="submit" name="answer" value="${escaped(value)}">${escaped(label)}</button>`;

/**
 * The question, in the business's name and nothing else's: five answers, which assistant for the
 * first, and the way past it with the same weight. Every button is a post that goes on to the form.
 */
export function questionPage(link: FoundLink): string {
  const heading = `How did you find ${escaped(link.business)}?`;
  const which = FOUND_ASSISTANTS.map((assistant) =>
    button(tapValue({ answer: "assistant", assistant }), FOUND_ASSISTANT_LABELS[assistant]),
  ).join("\n");
  const answer = (value: "search" | "someone_they_know" | "been_before" | "something_else") =>
    button(value, FOUND_ANSWER_LABELS[value]);
  return page(
    heading,
    `<h1>${heading}</h1>
<form method="post">
${button("assistant", FOUND_ANSWER_LABELS.assistant)}
<div class="which"><span>Which one?</span>
${which}
</div>
${answer("search")}
${answer("someone_they_know")}
${answer("been_before")}
${answer("something_else")}
${button("skipped", "Skip to the review")}
</form>
<p class="note">Your answer is counted with others and not kept with your name.</p>`,
  );
}

/** The page for a link this deployment did not sign, or that was cut short on its way. */
const NOT_WORKING = page(
  "This link is not working",
  `<h1>This link is not working</h1>
<p>Try the link in the email again. If it still does not open, the business can send you its review link.</p>`,
);

/** Queues the worker, and never stands between a customer and the form when that fails. */
async function queue(c: Context<AppEnv>, message: FoundMessage) {
  try {
    await c.env.SCAN_QUEUE.send(message);
  } catch (error) {
    console.error("Queueing a found answer failed", error);
  }
}

async function linkOf(c: Context<AppEnv>): Promise<FoundLink | null> {
  const keys = await askingKeys(c.env.CONNECTIONS_KEY);
  return keys ? keys.readFoundToken(c.req.param("token") ?? "") : null;
}

/** The question's routes, at `/r`: no sign-in, no store. */
export const foundRoutes = new Hono<AppEnv>();

foundRoutes.get("/:token", async (c) => {
  const link = await linkOf(c);
  if (!link) return c.body(NOT_WORKING, 404, PAGE_HEADERS);
  // A mail scanner opens links nobody reads, which only makes the share going on look lower.
  await queue(c, { found_opened: true });
  return c.body(questionPage(link), 200, PAGE_HEADERS);
});

foundRoutes.post("/:token", async (c) => {
  const link = await linkOf(c);
  if (!link) return c.body(NOT_WORKING, 404, PAGE_HEADERS);
  let tapped: unknown;
  try {
    tapped = (await c.req.parseBody()).answer;
  } catch {
    tapped = undefined;
  }
  await queue(c, { found: { action_id: link.action_id, ...readTap(tapped) } });
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.redirect(link.form, 303);
});

/** The message the question's route queued for `recordFound`, or null where the body is not one. */
export function readFoundMessage(body: unknown): FoundMessage | null {
  return FoundMessageSchema.safeParse(body).data ?? null;
}

/** Counts what the question's route was told and queued. */
export async function recordFound(
  message: FoundMessage,
  { store }: { store: Store },
): Promise<"opened" | "counted" | "already" | "gone"> {
  if ("found_opened" in message) {
    await store.recordFoundOpened();
    return "opened";
  }
  const { action_id, answer, assistant } = message.found;
  return store.recordFoundAnswer(action_id, { answer, assistant }, { sample: false });
}
