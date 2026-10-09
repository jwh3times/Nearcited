import { CONTACT_EMAIL, GOVERNING_LAW, OPERATOR } from "../../lib/legal";
import { LegalPage } from "./LegalPage";

const mail = <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;

export function Terms() {
  return (
    <LegalPage
      title="Terms of service"
      summary="The agreement between you and Nearcited when you use the service. The short version: use it for your own business, don't abuse it, and treat what it shows as a measurement, not a promise."
    >
      <h2>The agreement</h2>
      <p>
        Nearcited is operated by {OPERATOR} ("we", "us"). By creating an account or using the
        service you agree to these terms. If you use it for a company or other organization, you are
        agreeing for that organization and confirm you are allowed to. If you do not agree, do not
        use the service.
      </p>

      <h2>What the service does</h2>
      <p>
        Nearcited asks AI assistants the questions you choose, records whether their answers name
        your business, who else they name and which websites they cite, reads your website's home
        page, and suggests what to do next.
      </p>
      <ul>
        <li>
          <strong>It measures; it does not guarantee.</strong> The assistants are run by other
          companies and can answer the same question differently each time. A score or a count here
          is a record of what was observed, not a prediction, and nothing we suggest is guaranteed
          to change an answer.
        </li>
        <li>
          <strong>The answers are not ours.</strong> What an assistant says about your business or
          anyone else's is that assistant's output. It can be wrong. We show it as we received it
          and do not vouch for it.
        </li>
        <li>
          <strong>It is not professional advice.</strong> Nothing here is legal, financial or
          marketing advice you should rely on without your own judgment.
        </li>
      </ul>

      <h2>Your account</h2>
      <p>
        You sign in with a link sent to your email address, so keep that mailbox secure: anyone who
        can read it can sign in as you. You are responsible for what is done under your account. You
        must be at least 18.
      </p>

      <h2>What you may not do</h2>
      <ul>
        <li>Track a business you have no connection to in order to harass or defame it.</li>
        <li>
          Enter prompts meant to make an assistant produce unlawful, abusive or deceptive content.
        </li>
        <li>
          Get around the limits on your plan, or use the service to resell access to the assistants.
        </li>
        <li>
          Probe, overload or break the service, or try to reach another organization's information.
        </li>
        <li>Use the service in breach of the law or of anyone else's rights.</li>
      </ul>
      <p>
        Security research in good faith is welcome; see the security policy in our public code
        repository for how to report what you find.
      </p>

      <h2>What you put in, and what comes out</h2>
      <p>
        What you enter stays yours. You give us permission to store it and send it to the companies
        that help run the service, as the <a href="/privacy">privacy policy</a> describes, for the
        purpose of running the service for you. You confirm you have the right to enter it.
      </p>
      <p>
        You may use the results for your own business. The assistants' answers and the websites they
        cite belong to whoever owns them, and their links are shown because the assistants' own
        terms require it.
      </p>

      <h2>Reports about a business</h2>
      <p>
        We may prepare a report on a business that has not signed up and send its owner a private
        link. A report is offered as information about that business's own visibility. If one is
        about your business and you want it withdrawn, write to {mail} and we will remove it.
      </p>

      <h2>Plans and payment</h2>
      <p>
        The free plan costs nothing. Every plan, what it includes and what it costs is shown on the{" "}
        <a href="/pricing">pricing page</a> before you are asked to pay for anything, and you are
        not charged without choosing to subscribe.
      </p>
      <ul>
        <li>
          <strong>Billing.</strong> A paid plan is a monthly subscription, paid in advance through
          Stripe, our payment provider. Prices are in US dollars and tax is added where it applies.
          It renews each month until you cancel. We never see or keep your card number.
        </li>
        <li>
          <strong>Cancelling.</strong> The owner of an organization can cancel at any time from
          Account settings. Your plan runs to the end of the month you have paid for and is not
          renewed. We do not refund part of a month, except where the law requires it.
        </li>
        <li>
          <strong>Changing plan.</strong> Moving to a plan that costs more takes effect at once, and
          you are charged the difference for the rest of the month. Moving to one that costs less
          takes effect at the end of the month you have paid for.
        </li>
        <li>
          <strong>If a payment fails.</strong> We try again over the following days and tell you by
          email. If it still cannot be collected, your subscription ends and your organization moves
          to the free plan.
        </li>
        <li>
          <strong>When a plan covers less than you have.</strong> Nothing is deleted. Locations and
          prompts the plan does not cover are paused, stay readable, and come back on a plan that
          covers them.
        </li>
        <li>
          <strong>If we change a price or a plan.</strong> We will email the owner at least 30 days
          before a higher price, or a reduction in what your plan includes, applies to you. A higher
          price first applies at your next renewal after that notice. You can change plan or cancel
          before it does. Changes that cost you nothing, such as a lower price or a plan that
          includes more, may apply without notice.
        </li>
      </ul>

      <h2>The software</h2>
      <p>
        The code that runs Nearcited is published under the GNU Affero General Public License,
        version 3. That license covers the code. These terms cover your use of the service we
        operate at nearcited.com, and the name "Nearcited" is not licensed by either.
      </p>

      <h2>Ending it</h2>
      <p>
        You may stop using the service at any time, and may ask us to delete your account by writing
        to {mail}. We may suspend or close an account that breaks these terms or puts the service or
        other people at risk, and may stop offering the service; where we reasonably can, we will
        give notice first and a chance to take your information with you.
      </p>

      <h2>No warranty</h2>
      <p>
        The service is provided "as is" and "as available". To the extent the law allows, we make no
        warranties, express or implied, including that the service will be uninterrupted or free of
        errors, or that any result is accurate or fit for a particular purpose.
      </p>

      <h2>Limit of liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect, incidental or consequential
        losses, or for lost profits, revenue, data or goodwill, arising from your use of the
        service. Our total liability for any claim about the service is limited to the greater of
        what you paid us for it in the twelve months before the claim, or one hundred U.S. dollars.
        Some places do not allow some of these limits, so they may not all apply to you.
      </p>

      <h2>Law and disputes</h2>
      <p>
        These terms are governed by the laws of the State of {GOVERNING_LAW}, without regard to its
        rules on conflicts of law. Disputes will be heard in the state or federal courts located in{" "}
        {GOVERNING_LAW}, unless the law where you live gives you the right to bring them elsewhere.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may change these terms. If a change matters, we will say so here and by email before it
        takes effect. Using the service after that means you accept the change. If part of these
        terms cannot be enforced, the rest still applies.
      </p>

      <h2>Contact</h2>
      <p>Questions about these terms: {mail}.</p>
    </LegalPage>
  );
}
