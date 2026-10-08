import { CONTACT_EMAIL } from "../../lib/legal";
import { LegalPage } from "./LegalPage";

export function Bot() {
  return (
    <LegalPage
      title="Our crawler"
      summary="If you run a website and saw a visit from NearcitedBot in your logs, this is what it was, what it read, and how to make it stop."
    >
      <h2>What it is</h2>
      <p>
        Nearcited shows businesses whether AI assistants name them. As part of that, it reads the
        home page of a business's own website, to tell its owner whether an assistant's crawler
        could read it. NearcitedBot is the program that does the reading. It identifies itself as:
      </p>
      <pre>
        <code>NearcitedBot/1.0 (+https://nearcited.com/bot)</code>
      </pre>

      <h2>What it reads</h2>
      <ul>
        <li>
          <strong>One page and one file.</strong> The site's home page and its{" "}
          <code>robots.txt</code>, following a few redirects if there are any. It does not follow
          links, crawl the rest of the site, submit forms or run the page's scripts.
        </li>
        <li>
          <strong>Rarely.</strong> A site is read when a business tracking it is scanned, which is
          usually once a day or less and never more than a handful of times, or once when a one-off
          report is prepared about it.
        </li>
        <li>
          <strong>Only sites someone named.</strong> It visits a site because that address was
          entered as a business's own website. It does not discover sites by itself.
        </li>
      </ul>

      <h2>What it keeps</h2>
      <p>
        Not the page. It keeps the result of a short list of checks: whether the page loaded,
        whether <code>robots.txt</code> shuts out the assistants' crawlers, whether the page asks
        not to be indexed, how many words it has before scripts run, and whether it states the
        business's name and city and carries structured business details. The page's content is not
        stored, is not used to train anything, and is not shown to anyone else.
      </p>

      <h2>How to stop it</h2>
      <p>
        NearcitedBot reads <code>robots.txt</code> to report what it says to the assistants'
        crawlers. It reads a single page at a business owner's request and does not yet act on rules
        addressed to itself, so a <code>robots.txt</code> rule will not stop it today. To have your
        site left alone, either:
      </p>
      <ul>
        <li>
          write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> with the address, and we
          will stop reading it; or
        </li>
        <li>block requests whose user agent contains "NearcitedBot" at your server or firewall.</li>
      </ul>
      <p>
        If it is misbehaving in any way, for example visiting more often than this page says, we
        want to know: write to the same address.
      </p>
    </LegalPage>
  );
}
