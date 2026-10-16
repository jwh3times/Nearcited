import {
  buildBusinessBlock,
  type HostedAnswer,
  type HostedBusiness,
  pageClosing,
  pageParts,
} from "@nearcited/shared";

/**
 * Hosted pages as they are sent: plain HTML an assistant reads without running anything, with the
 * business's name linking to its own site, and nothing of Nearcited's but a generator tag. Every
 * word comes from the database's answer and is written as text, never as markup.
 */

/** Text as it is written into HTML, in an element or an attribute. */
export function asText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Small, readable and the same on every page. No font, image or script is fetched. */
const STYLE = `body{margin:0;font:18px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1b19;background:#fbfaf7}
header,main,footer{max-width:42rem;margin:0 auto;padding:1.25rem 1rem}
header{border-bottom:1px solid #e4e1da;font-weight:600}
footer{border-top:1px solid #e4e1da;font-size:.9rem;color:#5e5b54}
a{color:#1d4ed8}h1{font-size:1.9rem;line-height:1.2}h2{font-size:1.3rem;margin-top:2rem}
ul{padding-left:1.25rem}li{margin:.4rem 0}
@media (prefers-color-scheme:dark){body{color:#ece9e2;background:#191816}a{color:#93b4ff}header,footer{border-color:#3a3833}footer{color:#a9a59c}}`;

/** The business's name, linking to its own site where one is on file. */
const businessLink = (business: HostedBusiness): string =>
  business.website
    ? `<a href="${asText(business.website)}">${asText(business.name)}</a>`
    : asText(business.name);

/** A whole document: the head every page shares, then what is in it. */
function documentOf(
  business: HostedBusiness,
  title: string,
  canonical: string | null,
  body: string,
): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${asText(title)}</title>`,
    '<meta name="generator" content="Nearcited">',
    ...(canonical ? [`<link rel="canonical" href="${asText(canonical)}">`] : []),
    `<style>${STYLE}</style>`,
    buildBusinessBlock(business).html,
    "</head>",
    "<body>",
    `<header>${businessLink(business)}</header>`,
    `<main>${body}</main>`,
    `<footer>${businessLink(business)}</footer>`,
    "</body>",
    "</html>",
  ].join("\n");
}

/** A live page: its title, its copy in headings and paragraphs, and the closing made by rule. */
function pageDocument(answer: Extract<HostedAnswer, { kind: "page" }>, address: string): string {
  const { business } = answer;
  const { blocks } = pageParts(answer.copy);
  const body = [
    `<h1>${asText(answer.title)}</h1>`,
    ...blocks.map((block) =>
      block.heading ? `<h2>${asText(block.text)}</h2>` : `<p>${asText(block.text)}</p>`,
    ),
    `<p>${asText(pageClosing(business))}</p>`,
  ].join("\n");
  return documentOf(business, `${answer.title} | ${business.name}`, address, body);
}

/** The bare subdomain: the business's pages, newest first, and the way to its own site. */
function listDocument(answer: Extract<HostedAnswer, { kind: "list" }>, origin: string): string {
  const { business } = answer;
  const pages = [...answer.pages].sort((a, b) => b.published_at.localeCompare(a.published_at));
  const body = [
    `<h1>${asText(business.name)}: answers to common questions</h1>`,
    pages.length > 0
      ? `<ul>\n${pages
          .map((page) => `<li><a href="/${asText(page.slug)}">${asText(page.title)}</a></li>`)
          .join("\n")}\n</ul>`
      : "<p>There are no pages here yet.</p>",
    ...(business.website ? [`<p>More on ${businessLink(business)}.</p>`] : []),
  ].join("\n");
  return documentOf(business, `Answers from ${business.name}`, `${origin}/`, body);
}

/** A page that was taken back, or that never was: one line, and the way to the business's site. */
function noPageDocument(business: HostedBusiness, gone: boolean): string {
  const line = gone ? "This page has been taken down." : "There is no page here.";
  const body = [
    `<h1>${line}</h1>`,
    business.website ? `<p>Go to ${businessLink(business)}.</p>` : "",
  ].join("\n");
  return documentOf(business, `${line} | ${business.name}`, null, body);
}

/** What one address answers: its status, and the document. */
export function render(answer: HostedAnswer, url: URL): { status: number; html: string } {
  switch (answer.kind) {
    case "page":
      return {
        status: 200,
        html: pageDocument(answer, `${url.origin}${url.pathname.replace(/\/$/, "")}`),
      };
    case "list":
      return { status: 200, html: listDocument(answer, url.origin) };
    case "gone":
      return { status: 410, html: noPageDocument(answer.business, true) };
    case "missing":
      return { status: 404, html: noPageDocument(answer.business, false) };
  }
}

/** The sitemap: the bare subdomain and every live page, each with the day it was published. */
export function sitemap(answer: Extract<HostedAnswer, { kind: "list" }>, origin: string): string {
  const urls = [
    `<url><loc>${asText(origin)}/</loc></url>`,
    ...answer.pages.map(
      (page) =>
        `<url><loc>${asText(origin)}/${asText(page.slug)}</loc><lastmod>${page.published_at.slice(0, 10)}</lastmod></url>`,
    ),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
