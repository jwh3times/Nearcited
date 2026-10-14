/*
 * Nearcited: counts a visit to this site that arrived from an AI assistant.
 *
 * It sends nothing at all unless this visit came from one of the assistants listed below. For
 * one that did, it sends the key in this script's tag, the assistant's host name and the path of
 * this page. It sets no cookie, keeps nothing in the browser and sends nothing about the visitor.
 *
 * What is collected, in full: https://nearcited.com/privacy
 */
(() => {
  try {
    // What a visit from each assistant carries: the site the browser names as where the visitor
    // came from, or the tag the assistant puts on the address it sends them to. The product
    // holds the same list (packages/shared/src/visits.ts), and a test keeps the two the same.
    // list:start
    const ASSISTANTS = {
      chatgpt: { hosts: ["chatgpt.com", "chat.openai.com"], tags: ["chatgpt.com"] },
      gemini: { hosts: ["gemini.google.com"], tags: [] },
      perplexity: { hosts: ["perplexity.ai"], tags: [] },
      copilot: { hosts: ["copilot.microsoft.com"], tags: [] },
      claude: { hosts: ["claude.ai"], tags: [] },
    };
    // list:end

    const script = document.currentScript;
    const key = script?.getAttribute("data-site");
    // Once for a page, however many times the line was pasted. Never inside a frame, where the
    // place a visitor "came from" is the page around the frame.
    if (!script || !key || window.nearcitedLine || window.top !== window.self) return;
    window.nearcitedLine = true;

    const send = (report) => {
      fetch(new URL("/api/visits", script.src), {
        method: "POST",
        body: JSON.stringify({ key, ...report }),
        // A plain post that asks for no answer and carries no cookie. It names this site, which
        // is how the visit is known to be here, and no page of it.
        mode: "no-cors",
        credentials: "omit",
        referrerPolicy: "origin",
        keepalive: true,
      }).catch(() => {});
    };

    // The site's owner looking to see that the line is here. It is noted and counts nothing.
    if (window.location.hash === "#nearcited-check") {
      send({ check: true });
      return;
    }

    // A reload, or a step back to this page, is the visit already counted.
    const [arrival] = performance.getEntriesByType("navigation");
    if (arrival && arrival.type !== "navigate") return;

    let referrer = "";
    try {
      referrer = new URL(document.referrer).hostname.toLowerCase();
    } catch {
      // No site is named, or what is there is not an address.
    }
    const tag = (new URLSearchParams(window.location.search).get("utm_source") ?? "")
      .trim()
      .toLowerCase();

    const lists = Object.values(ASSISTANTS);
    const named = lists.some(({ hosts }) =>
      hosts.some((host) => referrer === host || referrer.endsWith(`.${host}`)),
    );
    // A tag counts only where the browser names no site, which is how a visit out of an
    // assistant's app arrives. A tagged link somebody posted elsewhere arrives from elsewhere.
    const tagged = !referrer && lists.some(({ tags }) => tags.includes(tag));
    if (!named && !tagged) return;

    // The host and not the address the visitor came from, which can hold what they asked. The
    // path and not what follows its question mark, which can hold anything.
    send({
      referrer: named ? referrer : null,
      tag: tagged ? tag : null,
      path: window.location.pathname,
    });
  } catch {
    // Whatever goes wrong here is not the site's problem.
  }
})();
