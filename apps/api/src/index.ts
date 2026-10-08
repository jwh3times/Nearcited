import {
  type AuditMessage,
  AuditMessageSchema,
  type ScanMessage,
  ScanMessageSchema,
} from "@nearcited/shared";
import { createApp } from "./app";
import { runAuditPart } from "./audits/runner";
import { buildScanReportEmail, sendEmail } from "./email/report";
import type { Env } from "./env";
import { createProviders, liveScansUnavailable, usesSampleData } from "./providers";
import { runScan } from "./scans/runner";
import { enqueueDueScans, failStaleAudits, failStaleScans } from "./scans/schedule";
import { fetchSite } from "./site/fetch";
import { createAdminClient, createSupabaseStore } from "./store/supabase";
import { activeTuning } from "./tuning";

const app = createApp();

/** The schedule that only sweeps. Any other trigger, including a manual test, also queues scans. */
const SWEEP_ONLY_CRON = "*/15 * * * *";

export default {
  // Only /api/* reaches the Worker. Everything else is served from the web app's build output
  // (see "assets" in wrangler.jsonc).
  fetch: app.fetch,

  /**
   * Cron. Every run clears abandoned scans and unfinished audits; the daily run also queues a
   * scan for every location that is due. The two schedules are in wrangler.jsonc.
   */
  async scheduled(controller, env) {
    const store = createSupabaseStore(createAdminClient(env));
    const abandoned = await failStaleScans(store);
    if (abandoned > 0) console.log(`Failed ${abandoned} abandoned scans`);
    const unfinished = await failStaleAudits(store);
    if (unfinished > 0) console.log(`Failed ${unfinished} unfinished audits`);
    if (controller.cron === SWEEP_ONLY_CRON) return;

    const queued = await enqueueDueScans(store, env.SCAN_QUEUE);
    console.log(`Queued ${queued} scheduled scans`);
  },

  /** Queue consumer: run each scan, and email its report if it was a scheduled one. */
  async queue(batch, env) {
    const store = createSupabaseStore(createAdminClient(env));
    const providers = createProviders(env, activeTuning.tuning);

    for (const message of batch.messages) {
      const audit = AuditMessageSchema.safeParse(message.body);
      if (audit.success) {
        const { audit_id, prompt_index } = audit.data;
        try {
          const outcome = await runAuditPart(audit_id, prompt_index, {
            store,
            providers,
            weights: activeTuning.tuning.score,
            sampleData: usesSampleData(env),
            unavailable: liveScansUnavailable(env, activeTuning.source),
            inspectSite: fetchSite,
          });
          console.log(`Audit ${audit_id} prompt ${prompt_index} ${outcome}`);
          message.ack();
        } catch (error) {
          console.error(`Audit ${audit_id} prompt ${prompt_index} failed, will retry`, error);
          message.retry();
        }
        continue;
      }

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
          sampleData: usesSampleData(env),
          // A deployment on sample data makes no real requests, so it does not fetch sites either.
          inspectSite: usesSampleData(env) ? undefined : fetchSite,
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
} satisfies ExportedHandler<Env, ScanMessage | AuditMessage>;
