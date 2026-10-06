import { type ScanMessage, ScanMessageSchema } from "@nearcited/shared";
import { createApp } from "./app";
import { buildScanReportEmail, sendEmail } from "./email/report";
import type { Env } from "./env";
import { createProviders, liveScansUnavailable } from "./providers";
import { runScan } from "./scans/runner";
import { enqueueDueScans } from "./scans/schedule";
import { createAdminClient, createSupabaseStore } from "./store/supabase";
import { activeTuning } from "./tuning";

const app = createApp();

export default {
  // Only /api/* reaches the Worker. Everything else is served from the web app's build output
  // (see "assets" in wrangler.jsonc).
  fetch: app.fetch,

  /** Cron: queue a scan for every location that is due. */
  async scheduled(_controller, env) {
    const store = createSupabaseStore(createAdminClient(env));
    const queued = await enqueueDueScans(store, env.SCAN_QUEUE);
    console.log(`Queued ${queued} scheduled scans`);
  },

  /** Queue consumer: run each scan, and email its report if it was a scheduled one. */
  async queue(batch, env) {
    const store = createSupabaseStore(createAdminClient(env));
    const providers = createProviders(env, activeTuning.tuning);

    for (const message of batch.messages) {
      const parsed = ScanMessageSchema.safeParse(message.body);
      if (!parsed.success) {
        console.error("Dropping malformed scan message", message.body);
        message.ack();
        continue;
      }
      try {
        const outcome = await runScan(parsed.data.scan_id, {
          store,
          providers,
          weights: activeTuning.tuning.score,
          unavailable: liveScansUnavailable(env, activeTuning.source),
          // Without a Resend key there is nobody to tell, so skip the owner lookup too.
          notify: env.RESEND_API_KEY
            ? async (report) => {
                const owners = await store.listOwnerEmails(report.location.organization_id);
                await sendEmail(env, owners, buildScanReportEmail(report, env.APP_URL));
              }
            : undefined,
        });
        console.log(`Scan ${parsed.data.scan_id} ${outcome}`);
        message.ack();
      } catch (error) {
        console.error(`Scan ${parsed.data.scan_id} failed, will retry`, error);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, ScanMessage>;
