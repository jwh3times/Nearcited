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
        could read it, and a few pages that assistants cited when answering questions about the
        business, to tell its owner whether those pages show the business's details correctly.
        NearcitedBot is the program that does the reading. It identifies itself as:
      </p>
      <pre>
        <code>NearcitedBot/1.0 (+https://nearcited.com/bot)</code>
      </pre>

      <h2>What it reads</h2>
      <ul>
        <li>
          <strong>
            <code>robots.txt</code> first.
          </strong>{" "}
          Before it asks a site for a page, it reads the site's <code>robots.txt</code>, and again
          for each other host a redirect leads to.
        </li>
        <li>
          <strong>On a business's own site, one page.</strong> The home page, following a few
          redirects if there are any, because that address was entered as the business's own
          website.
        </li>
        <li>
          <strong>Elsewhere, only a page an assistant cited.</strong> When assistants answering a
          question about a business keep citing a page on a directory site, it reads that one page,
          to compare it with the business's details. At most three such pages, one a site, each time
          a business is scanned. A redirect off the site that was cited is not followed.
        </li>
        <li>
          <strong>Nothing more.</strong> It does not follow links, crawl the rest of a site, submit
          forms or run a page's scripts, and it does not discover sites by itself.
        </li>
        <li>
          <strong>Rarely.</strong> A page is read when a business it concerns is scanned, which is
          usually once a day or less and never more than a handful of times, or once when a one-off
          report is prepared about a business's own site.
        </li>
      </ul>

      <h2>What it keeps</h2>
      <p>
        Not the page. From a business's own home page it keeps the result of a short list of checks:
        whether the page loaded, whether <code>robots.txt</code> shuts out the assistants' crawlers,
        whether the page asks not to be indexed, how many words it has before scripts run, and
        whether it states the business's name and city and carries structured business details. From
        a cited page it keeps whether the page names the business, and whether it shows the
        business's phone number and address, with the number it shows if that differs. No page's
        content is stored, used to train anything, or shown to anyone else.
      </p>

      <h2>How to stop it</h2>
      <p>
        NearcitedBot obeys <code>robots.txt</code>, read the standard way (RFC 9309). It follows the
        rules in a group for <code>NearcitedBot</code>, or the rules for <code>*</code> where no
        group names it. If your <code>robots.txt</code> answers with a server error or does not
        answer at all, it reads nothing from your site until it does. To keep it out of your whole
        site:
      </p>
      <pre>
        <code>User-agent: NearcitedBot{"\n"}Disallow: /</code>
      </pre>
      <p>
        One exception: on a business's own website, which its owner asked to have checked, it
        follows only rules that name <code>NearcitedBot</code>, so that it can tell the owner when
        the site's <code>*</code> rules shut out the assistants' crawlers. You can also:
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
