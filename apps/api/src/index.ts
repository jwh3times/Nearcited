import {
  type ActionMessage,
  ActionMessageSchema,
  type AuditMessage,
  AuditMessageSchema,
  type ConnectionMessage,
  ConnectionMessageSchema,
  type LimitChangeMessage,
  LimitChangeMessageSchema,
  type PriceChangeMessage,
  PriceChangeMessageSchema,
  type ScanMessage,
  ScanMessageSchema,
} from "@nearcited/shared";
import { carryOutAction, proposeAfterSync, requeueStalledActions } from "./actions";
import { sendActionNotices } from "./actions/notice";
import { createApp } from "./app";
import { runAuditPart } from "./audits/runner";
import { authenticateWithSupabase } from "./auth";
import { advanceLimitChanges, runLimitChangeStep } from "./billing/limit-change";
import { advancePriceChanges, runPriceChangeStep } from "./billing/price-change";
import { createStripePayments } from "./billing/stripe";
import {
  enqueueDueSyncs,
  expirePausedConnections,
  remindBrokenConnections,
  removeConnection,
  requeueFirstSyncs,
  requeueStalledRemovals,
  syncConnection,
  tellBrokenConnections,
} from "./connections";
import { sealingKey } from "./connections/seal";
import { buildScanReportEmail, type Email, sendEmail } from "./email/report";
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
   * Cron. Every run clears abandoned scans and unfinished audits, and asks again for any
   * connection's removal or first sync that has not been finished and any approved action nobody
   * is carrying out; the daily run also queues a scan for every location that is due and a sync
   * for every connection that is, and lapses the proposals nobody answered. The two schedules are
   * in wrangler.jsonc.
   */
  async scheduled(controller, env) {
    const store = createSupabaseStore(createAdminClient(env));
    const abandoned = await failStaleScans(store);
    if (abandoned > 0) console.log(`Failed ${abandoned} abandoned scans`);
    const unfinished = await failStaleAudits(store);
    if (unfinished > 0) console.log(`Failed ${unfinished} unfinished audits`);
    const stalled = await requeueStalledRemovals(store, env.SCAN_QUEUE);
    if (stalled > 0) console.log(`Queued ${stalled} stalled removals of connections again`);
    const firstSyncs = await requeueFirstSyncs(store, env.SCAN_QUEUE);
    if (firstSyncs > 0) console.log(`Queued ${firstSyncs} first syncs of connections again`);
    const stalledActions = await requeueStalledActions(store, env.SCAN_QUEUE);
    if (stalledActions > 0) console.log(`Queued ${stalledActions} approved actions again`);
    if (controller.cron === SWEEP_ONLY_CRON) return;

    const queued = await enqueueDueScans(store, env.SCAN_QUEUE);
    console.log(`Queued ${queued} scheduled scans`);
    const syncs = await enqueueDueSyncs(store, env.SCAN_QUEUE);
    if (syncs > 0) console.log(`Queued ${syncs} syncs of connections`);
    const lapsed = await store.lapseActions();
    if (lapsed > 0) console.log(`Lapsed ${lapsed} actions that waited fourteen days`);
    // The day's message to each organization's owners: what was done, and what is waiting.
    const noticed = await sendActionNotices({
      store,
      send: env.RESEND_API_KEY
        ? (to: string[], email: Email) => sendEmail(env, to, email)
        : undefined,
      appUrl: env.APP_URL,
    });
    if (noticed > 0) console.log(`Told the owners of ${noticed} organizations what was done`);
    const expired = await expirePausedConnections(store, env.SCAN_QUEUE);
    if (expired > 0) console.log(`Began removing ${expired} connections paused for thirty days`);
    const telling = {
      store,
      key: null,
      send: env.RESEND_API_KEY
        ? (to: string[], email: Email) => sendEmail(env, to, email)
        : undefined,
      appUrl: env.APP_URL,
    };
    // Reminders first, so one told today for the first time is not also reminded today.
    const reminded = await remindBrokenConnections(telling);
    if (reminded > 0) console.log(`Reminded the owners of ${reminded} broken connections`);
    const told = await tellBrokenConnections(telling);
    if (told > 0) console.log(`Told the owners of ${told} broken connections, late`);
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

      const connection = ConnectionMessageSchema.safeParse(message.body);
      if (connection.success) {
        const { connection_id, step } = connection.data;
        const what = `Connection ${connection_id} ${step}`;
        try {
          const deps = {
            store,
            key: await sealingKey(env.CONNECTIONS_KEY),
            // Without a Resend key there is nobody to tell when one breaks.
            send: env.RESEND_API_KEY
              ? (to: string[], email: Email) => sendEmail(env, to, email)
              : undefined,
            appUrl: env.APP_URL,
          };
          const outcome =
            step === "remove"
              ? await removeConnection(connection_id, deps)
              : await syncConnection(connection_id, deps);
          console.log(`${what}: ${outcome}`);
          // What a sync read may show something to do. Proposing is the worker's alone.
          if (outcome === "synced") {
            const proposed = await proposeAfterSync(connection_id, deps);
            if (proposed > 0) console.log(`${what}: proposed ${proposed} actions`);
          }
          message.ack();
        } catch (error) {
          console.error(`${what} failed, will retry`, error);
          message.retry();
        }
        continue;
      }

      const action = ActionMessageSchema.safeParse(message.body);
      if (action.success) {
        const what = `Action ${action.data.action_id}`;
        try {
          const outcome = await carryOutAction(action.data.action_id, {
            store,
            key: await sealingKey(env.CONNECTIONS_KEY),
          });
          console.log(`${what}: ${outcome}`);
          // The thing had changed since the member was shown it. Reading the account again now
          // proposes a fresh action against what is there, without waiting for the daily run.
          if (outcome === "out_of_date") {
            const kept = await store.getAction(action.data.action_id);
            if (kept?.connection_id) {
              await env.SCAN_QUEUE.send({ connection_id: kept.connection_id, step: "sync" });
            }
          }
          // A try that did not work is made again in ten minutes, three times in all.
          if (outcome === "again") message.retry({ delaySeconds: 600 });
          else message.ack();
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
  | ScanMessage
  | AuditMessage
  | PriceChangeMessage
  | LimitChangeMessage
  | ConnectionMessage
  | ActionMessage
>;
