import type { AuditMessage, ScanMessage } from "@nearcited/shared";

/** Bindings and variables from wrangler.jsonc, plus secrets set with `wrangler secret put`. */
export interface Env {
  ASSETS: Fetcher;
  /** Carries scans, and the prompts of shareable audits. */
  SCAN_QUEUE: Queue<ScanMessage | AuditMessage>;

  SUPABASE_URL: string;
  /** Safe to expose. Used with the caller's own token, so row-level security applies. */
  SUPABASE_PUBLISHABLE_KEY: string;
  /** Secret. Bypasses row-level security. Only the scan worker and the scheduler use it. */
  SUPABASE_SECRET_KEY: string;

  /** "mock" returns generated data and costs nothing. "live" calls real providers. */
  PROVIDER_MODE: string;
  APP_URL: string;
  EMAIL_FROM: string;
  /** Optional. Where a reply to a scan report goes. Without it, replies go to `EMAIL_FROM`. */
  EMAIL_REPLY_TO?: string;
  /** Optional secret. With it, live scans check ChatGPT; without it that surface is skipped. */
  OPENAI_API_KEY?: string;
  /** Optional secret. With it, live scans check Claude; without it that surface is skipped. */
  ANTHROPIC_API_KEY?: string;
  /** Optional. Without it, scheduled scans finish without sending a report. */
  RESEND_API_KEY?: string;
}
