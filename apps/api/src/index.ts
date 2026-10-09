import {
  type AuditMessage,
  AuditMessageSchema,
  type LimitChangeMessage,
  LimitChangeMessageSchema,
  type PriceChangeMessage,
  PriceChangeMessageSchema,
  type ScanMessage,
  ScanMessageSchema,
} from "@nearcited/shared";
import { createApp } from "./app";
import { runAuditPart } from "./audits/runner";
import { authenticateWithSupabase } from "./auth";
import { advanceLimitChanges, runLimitChangeStep } from "./billing/limit-change";
import { advancePriceChanges, runPriceChangeStep } from "./billing/price-change";
import { createStripePayments } from "./billing/stripe";
import { buildScanReportEmail, sendEmail } from "./email/report";
import type { Env } from "./env";
import { createProviders, liveScansUnavailable, usesSampleData } from "./providers";
import { createMockProviders } from "./providers/mock";
import { runScan } from "./scans/runner";
import { enqueueDueScans, failStaleAudits, failStaleScans } from "./scans/schedule";
import { fetchSite } from "./site/fetch";
import { createAdminClient, createSupabaseStore } from "./store/supabase";
import { activeTuning } from "./tuning";

const app = createApp({
  authenticate: authenticateWithSupabase,
  deployment: {
    models: {
      chatgpt: activeTuning.tuning.chatgpt.model,
      claude: activeTuning.tuning.claude.model,
    },
    rates: activeTuning.tuning.rates,
  },
});

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
    const steps = await advancePriceChanges(store, env.SCAN_QUEUE);
    if (steps > 0) console.log(`Queued ${steps} price change steps`);
    const reductions = await advanceLimitChanges(store, env.SCAN_QUEUE);
    if (reductions > 0) console.log(`Made ${reductions} announced reductions`);
  },

  /** Queue consumer: run each scan, and email its report if it was a scheduled one. */
  async queue(batch, env) {
    const store = createSupabaseStore(createAdminClient(env));
    const providers = createProviders(env, activeTuning.tuning);
    // What a test organization's scans use, whatever this deployment's own mode is.
    const sampleProviders = createMockProviders();

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

      const priceChange = PriceChangeMessageSchema.safeParse(message.body);
      if (priceChange.success) {
        const { price_change_id, organization_id, step } = priceChange.data;
        const what = `Price change ${price_change_id} ${step} for ${organization_id}`;
        // Both are needed to tell anyone or to move anyone. Without them the step is kept for
        // the dead-letter queue instead of being quietly dropped.
        if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !env.RESEND_API_KEY) {
          console.error(`${what} cannot run: the payment provider or email is not set up`);
          message.retry();
          continue;
        }
        try {
          const outcome = await runPriceChangeStep(priceChange.data, {
            store,
            payments: createStripePayments(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET),
            send: (to, email) => sendEmail(env, to, email),
            appUrl: env.APP_URL,
          });
          console.log(`${what}: ${outcome}`);
          message.ack();
        } catch (error) {
          console.error(`${what} failed, will retry`, error);
          message.retry();
        }
        continue;
      }

      const limitChange = LimitChangeMessageSchema.safeParse(message.body);
      if (limitChange.success) {
        const { limit_change_id, organization_id, step } = limitChange.data;
        const what = `Reduction ${limit_change_id} ${step} for ${organization_id}`;
        // Telling people is all this does, so without email it waits for the dead-letter queue.
        if (!env.RESEND_API_KEY) {
          console.error(`${what} cannot run: outgoing email is not set up`);
          message.retry();
          continue;
        }
        try {
          const outcome = await runLimitChangeStep(limitChange.data, {
            store,
            send: (to, email) => sendEmail(env, to, email),
            appUrl: env.APP_URL,
          });
          console.log(`${what}: ${outcome}`);
          message.ack();
        } catch (error) {
          console.error(`${what} failed, will retry`, error);
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
          sampleProviders,
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
} satisfies ExportedHandler<
  Env,
  ScanMessage | AuditMessage | PriceChangeMessage | LimitChangeMessage
>;
