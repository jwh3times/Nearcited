import type {
  ActionMessage,
  AuditMessage,
  ClosingMessage,
  ConnectionMessage,
  DraftMessage,
  LimitChangeMessage,
  OptOutMessage,
  PriceChangeMessage,
  ScanMessage,
  StoppedAddressMessage,
  SubscriptionFitMessage,
} from "@nearcited/shared";

/** Bindings and variables from wrangler.jsonc, plus secrets set with `wrangler secret put`. */
export interface Env {
  ASSETS: Fetcher;
  /**
   * Carries scans, the prompts of shareable audits, the steps of a price change or of a
   * reduction in what a plan allows, what the worker is asked to do for a connection, the
   * approved actions it is asked to carry out, the drafts it is asked to write, the
   * accounts it is asked to close, the subscriptions it is asked to fit to their plan, and the
   * opt-outs, bounces and complaints of review requests it is asked to record.
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
    | OptOutMessage
    | StoppedAddressMessage
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
  /**
   * Optional secrets. DataForSEO's API sign-in. With both, and `MAPBOX_TOKEN`, live scans check a
   * Google keyword on the map pack, organic results, AI Overview and AI Mode, for an organization
   * whose plan includes Google results. Without them the Google surfaces are skipped.
   */
  DATAFORSEO_LOGIN?: string;
  DATAFORSEO_PASSWORD?: string;
  /**
   * Optional secret. A Mapbox access token, for finding the point a location's Google results
   * are checked from. Its account needs a card on file, which permanent geocoding requires.
   */
  MAPBOX_TOKEN?: string;
  /** Optional. Without it, scheduled scans finish without sending a report. */
  RESEND_API_KEY?: string;
  /**
   * Optional. The address review requests are sent from, on the product's sending subdomain, such
   * as `requests@ask.example.com`; each goes under the business's name. Without it, or without
   * `RESEND_API_KEY`, an approved review request fails instead of going out.
   */
  REVIEW_REQUESTS_FROM?: string;
  /**
   * Optional secret. The signing secret of the Resend webhook that reports bounces and complaints
   * (`whsec_...`). Without it the webhook is off, and no bounce or complaint is recorded.
   */
  RESEND_WEBHOOK_SECRET?: string;
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
  /**
   * Optional secret, with `GOOGLE_CLIENT_SECRET`. This deployment's project at Google, which owners
   * sign in through. Without both, no Google Analytics connection is offered or read.
   */
  GOOGLE_CLIENT_ID?: string;
  /** Optional secret, with `GOOGLE_CLIENT_ID`. */
  GOOGLE_CLIENT_SECRET?: string;
}
