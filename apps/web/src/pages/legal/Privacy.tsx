import { OPERATOR, PRIVACY_EMAIL } from "../../lib/legal";
import { LegalPage } from "./LegalPage";

const mail = <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>;

export function Privacy() {
  return (
    <LegalPage
      title="Privacy policy"
      summary="What Nearcited collects, why, who else handles it, and how to have it corrected or deleted. Nearcited is about businesses, not people, and collects little about either."
    >
      <h2>Who this is from</h2>
      <p>
        Nearcited is operated by {OPERATOR}, an individual, in the United States. "We" and "us" in
        this policy mean the operator. For anything in this policy, write to {mail}.
      </p>

      <h2>What we collect</h2>
      <h3>When you have an account</h3>
      <ul>
        <li>
          <strong>Your email address.</strong> It is how you sign in: we email you a link, and there
          is no password. We also use it to send the scan reports you have scheduled.
        </li>
        <li>
          <strong>What you enter about your business.</strong> The organization's name, and for each
          location its name, address, phone number, website, category and Google place ID, and the
          prompts and keywords you choose to track.
        </li>
        <li>
          <strong>What the scans find.</strong> The answers AI assistants gave to your prompts,
          whether they named your business, which other businesses they named, the websites they
          cited, and the result of reading your website's home page.
        </li>
      </ul>

      <h3>When a report is made about a business</h3>
      <p>
        We can prepare a one-off report on a business that has not signed up, to show its owner. It
        holds the business's name, city and website, the questions asked, and what the assistants
        answered. It is reachable only by a private link, is kept for 30 days and can be withdrawn
        sooner. If a report is about your business and you want it removed, write to {mail}.
      </p>

      <h3>When you use the site</h3>
      <ul>
        <li>
          <strong>Server logs.</strong> Our hosting provider records requests to the site, including
          IP address, browser type and the time, to keep the service running and secure.
        </li>
        <li>
          <strong>Storage in your browser.</strong> We keep your sign-in session, your choice of
          light or dark theme, and which steps of an action plan you have ticked off. This stays in
          your browser. We set no advertising or tracking cookies and use no analytics service.
        </li>
      </ul>

      <h2>What we use it for</h2>
      <ul>
        <li>
          To run the service: ask the assistants your prompts, read your website, and show you the
          results.
        </li>
        <li>To sign you in and send the emails you have asked for.</li>
        <li>To keep the service secure and working, and to fix it when it is not.</li>
      </ul>
      <p>We do not sell personal information, and we do not use it for advertising.</p>

      <h2>Who else handles it</h2>
      <p>These companies process information for us so the service can work:</p>
      <ul>
        <li>
          <strong>Cloudflare</strong> hosts the site and the application, and keeps the request
          logs.
        </li>
        <li>
          <strong>Supabase</strong> stores the database and handles sign-in.
        </li>
        <li>
          <strong>OpenAI and Anthropic</strong> answer the prompts. Each prompt is sent with the
          city and region it is asked about. Your email address is not sent to them.
        </li>
        <li>
          <strong>Resend</strong> delivers our emails, so it receives your email address and the
          contents of the reports sent to you.
        </li>
      </ul>
      <p>
        Scans also read public websites, including your own home page, which the sites' operators
        can see as a visit from our crawler. See <a href="/bot">Our crawler</a>.
      </p>
      <p>
        We may also disclose information when the law requires it, or to protect the service or the
        people who use it. If the service is ever transferred to another operator, the information
        it holds would transfer with it, under this policy or one that protects it as well.
      </p>

      <h2>Where it is kept, and for how long</h2>
      <p>
        Information is processed in the United States and in the other countries where the companies
        above operate. Account information and scan results are kept for as long as the account
        exists. Deleting a location deletes its prompts and every scan of it. Reports on businesses
        that have not signed up expire after 30 days.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          <strong>See, correct or delete.</strong> You can change your business's details and delete
          locations yourself. To get a copy of what we hold, or to have your account and everything
          under it deleted, write to {mail}. We will answer within 30 days.
        </li>
        <li>
          <strong>Emails.</strong> Turn off scheduled scans for a location to stop its reports.
        </li>
        <li>
          <strong>Where the law gives you more.</strong> Some places, including the European
          Economic Area, the United Kingdom and some U.S. states, give people further rights over
          personal information, such as objecting to its use or complaining to a regulator. Write to
          us and we will honor the rights that apply to you.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        Connections to the site are encrypted. Each organization's information is separated from
        every other's in the database, and access to the systems is limited to the operator. No
        service can promise that nothing will ever go wrong; if something does and it affects your
        information, we will tell you.
      </p>

      <h2>Children</h2>
      <p>
        Nearcited is a tool for businesses. It is not meant for anyone under 18, and we do not
        knowingly collect information from children.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes in a way that matters, we will say so here and, when you have an
        account, by email, before the change takes effect. The date at the top of this page is when
        it last changed.
      </p>
    </LegalPage>
  );
}
