import type {
  ActionMessage,
  AuditMessage,
  ClosingMessage,
  ConnectionMessage,
  DraftMessage,
  LimitChangeMessage,
  PriceChangeMessage,
  ScanMessage,
  SubscriptionFitMessage,
} from "@nearcited/shared";

/** Bindings and variables from wrangler.jsonc, plus secrets set with `wrangler secret put`. */
export interface Env {
  ASSETS: Fetcher;
  /**
   * Carries scans, the prompts of shareable audits, the steps of a price change or of a
   * reduction in what a plan allows, what the worker is asked to do for a connection, the
   * approved actions it is asked to carry out, the drafts it is asked to write, the
   * accounts it is asked to close, and the subscriptions it is asked to fit to their plan.
   */
  SCAN_QUEUE: Queue<
    | ScanMessage
    | AuditMessage
    | PriceChangeMessage
    | LimitChangeMessage
    | ConnectionMessage
    | ActionMessage
    | DraftMessage
    | ClosingMessage
    | SubscriptionFitMessage
  >;

  SUPABASE_URL: string;
  /** Safe to expose. Used with the caller's own token, so row-level security applies. */
  SUPABASE_PUBLISHABLE_KEY: string;
  /**
   * Secret. Bypasses row-level security. Only the scan worker, the scheduler and the payment
   * provider's webhook use it.
   */
  SUPABASE_SECRET_KEY: string;

  /** "mock" returns generated data and costs nothing. "live" calls real providers. */
  PROVIDER_MODE: string;
  APP_URL: string;
  /** Optional. The commit this deployment was built from, set at deploy for the operator's view. */
  COMMIT?: string;
  EMAIL_FROM: string;
  /** Optional. Where a reply to a scan report goes. Without it, replies go to `EMAIL_FROM`. */
  EMAIL_REPLY_TO?: string;
  /** Optional secret. With it, live scans check ChatGPT; without it that surface is skipped. */
  OPENAI_API_KEY?: string;
  /**
   * Optional secret. With it, live scans check Claude, and a draft is written on real data where
   * the tuning has instructions for its kind. Without it that surface is skipped and no real
   * draft is written.
   */
  ANTHROPIC_API_KEY?: string;
  /** Optional. Without it, scheduled scans finish without sending a report. */
  RESEND_API_KEY?: string;
  /** Optional secret. Without both Stripe values nobody can subscribe and the webhook is off. */
  STRIPE_SECRET_KEY?: string;
  /** Optional secret. The signing secret of the webhook endpoint registered at Stripe. */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Optional secret. The key a connection's sign-in is sealed with: 32 random bytes in base64.
   * Without it nothing can be connected. Changing it makes every sign-in already kept unreadable.
   */
  CONNECTIONS_KEY?: string;
  /**
   * Optional, and only ever on a machine of one's own: the one origin of a WordPress running
   * there for testing, such as `http://localhost:8099`, which the Worker may then reach over
   * http. Never set on a deployment.
   */
  WORDPRESS_LOCAL_ORIGIN?: string;
  /**
   * Optional secret. A Cloudflare token that may create and remove custom hostnames on the zone
   * hosted pages are served from, and nothing else. Without it and `CLOUDFLARE_ZONE_ID`, no answer
   * subdomain is offered outside sample data.
   */
  CLOUDFLARE_HOSTNAMES_TOKEN?: string;
  /** Optional. The Cloudflare zone hosted pages are served from: `nearcited.com`'s. */
  CLOUDFLARE_ZONE_ID?: string;
}
