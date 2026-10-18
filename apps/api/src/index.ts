import {
  type ActionMessage,
  ActionMessageSchema,
  type AuditMessage,
  AuditMessageSchema,
  type ClosingMessage,
  ClosingMessageSchema,
  type ConnectionMessage,
  ConnectionMessageSchema,
  type DraftMessage,
  DraftMessageSchema,
  type LimitChangeMessage,
  LimitChangeMessageSchema,
  type PriceChangeMessage,
  PriceChangeMessageSchema,
  type ScanMessage,
  ScanMessageSchema,
  SubscriptionFitMessageSchema,
  strongerAssistants,
} from "@nearcited/shared";
import {
  carryOutAction,
  connectionToPublishWith,
  proposeAfterSync,
  requeueStalledActions,
} from "./actions";
import { sendActionNotices } from "./actions/notice";
import { createApp } from "./app";
import { runAuditPart } from "./audits/runner";
import { authenticateWithSupabase } from "./auth";
import { fitSubscription } from "./billing/fit";
import { advanceLimitChanges, runLimitChangeStep } from "./billing/limit-change";
import { advancePriceChanges, runPriceChangeStep } from "./billing/price-change";
import { createStripePayments } from "./billing/stripe";
import { closeAccount, dropFinishedClosings, requeueStalledClosings } from "./closing";
import {
  enqueueDueSyncs,
  expirePausedConnections,
  expireUnclaimedAnswerSubdomains,
  type Hosting,
  remindBrokenConnections,
  removeConnection,
  requeueAnswerSubdomainChecks,
  requeueFirstSyncs,
  requeueStalledRemovals,
  syncConnection,
  tellBrokenConnections,
  tellPausedAnswerSubdomains,
} from "./connections";
import { sealingKey } from "./connections/seal";
import { requeueStalledDrafts, writeDraft } from "./drafts";
import { createLiveDraftWriter, liveDraftKinds } from "./drafts/claude";
import { buildScanReportEmail, type Email, sendEmail } from "./email/report";
import type { Env } from "./env";
import {
  createGeocoder,
  createProviders,
  createStrongerProviders,
  liveScansUnavailable,
  usesSampleData,
} from "./providers";
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
    draft_kinds: liveDraftKinds(activeTuning),
    stronger_assistants: strongerAssistants(activeTuning.tuning),
  },
});

/** Where this deployment registers answer subdomains, if it can. */
const hostingOf = (env: Env): Hosting => ({
  cloudflare:
    env.CLOUDFLARE_HOSTNAMES_TOKEN && env.CLOUDFLARE_ZONE_ID
      ? { token: env.CLOUDFLARE_HOSTNAMES_TOKEN, zone: env.CLOUDFLARE_ZONE_ID }
      : null,
  sampleData: usesSampleData(env),
});

/** The schedule that only sweeps. Any other trigger, including a manual test, also queues scans. */
const SWEEP_ONLY_CRON = "*/15 * * * *";

export default {
  // Only /api/* reaches the Worker. Everything else is served from the web app's build output
  // (see "assets" in wrangler.jsonc).
  fetch: app.fetch,

  /**
   * Cron. Every run clears abandoned scans and unfinished audits, and asks again for any
   * connection's removal or first sync that has not been finished, any approved action nobody
   * is carrying out, any draft nobody is writing and any closing of an account nobody finished,
   * and checks again every answer subdomain still waiting for its record; the daily run also
   * queues a scan for every location that is due and a sync for every connection that is, lapses
   * the proposals nobody answered, drops what an action replaced once it may be kept no longer,
   * tells each organization's owners what was done for it, lets go of every answer subdomain
   * whose record never appeared, and forgets the accounts closed thirty days ago. The two
   * schedules are in wrangler.jsonc.
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
    const stalledDrafts = await requeueStalledDrafts(store, env.SCAN_QUEUE);
    if (stalledDrafts > 0) console.log(`Queued ${stalledDrafts} drafts again`);
    const closings = await requeueStalledClosings(store, env.SCAN_QUEUE);
    if (closings > 0) console.log(`Queued ${closings} unfinished closings of accounts again`);
    const waiting = await requeueAnswerSubdomainChecks(store, env.SCAN_QUEUE);
    if (waiting > 0) console.log(`Queued checks of ${waiting} answer subdomains still waiting`);
    // Told the day a plan stops including hosted pages, whenever in the day that is.
    const paused = await tellPausedAnswerSubdomains({
      store,
      key: null,
      send: env.RESEND_API_KEY
        ? (to: string[], email: Email) => sendEmail(env, to, email)
        : undefined,
      appUrl: env.APP_URL,
    });
    if (paused > 0) console.log(`Told the owners of ${paused} paused answer subdomains`);
    if (controller.cron === SWEEP_ONLY_CRON) return;

    const queued = await enqueueDueScans(store, env.SCAN_QUEUE);
    console.log(`Queued ${queued} scheduled scans`);
    const syncs = await enqueueDueSyncs(store, env.SCAN_QUEUE);
    if (syncs > 0) console.log(`Queued ${syncs} syncs of connections`);
    const lapsed = await store.lapseActions();
    if (lapsed > 0) console.log(`Lapsed ${lapsed} actions that waited fourteen days`);
    const dropped = await store.dropExpiredSeen();
    if (dropped > 0) console.log(`Dropped what ${dropped} actions replaced`);
    // The day's message to each organization's owners: what was done, and what is waiting.
    const noticed = await sendActionNotices({
      store,
      send: env.RESEND_API_KEY
        ? (to: string[], email: Email) => sendEmail(env, to, email)
        : undefined,
      appUrl: env.APP_URL,
      sampleData: usesSampleData(env),
    });
    if (noticed > 0) console.log(`Told the owners of ${noticed} organizations what was done`);
    const expired = await expirePausedConnections(store, env.SCAN_QUEUE);
    if (expired > 0) console.log(`Began removing ${expired} connections paused for thirty days`);
    const unclaimed = await expireUnclaimedAnswerSubdomains(store, env.SCAN_QUEUE);
    if (unclaimed > 0) console.log(`Began removing ${unclaimed} answer subdomains never set up`);
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

    const forgotten = await dropFinishedClosings(store);
    if (forgotten > 0) console.log(`Forgot ${forgotten} accounts closed thirty days ago`);

    const steps = await advancePriceChanges(store, env.SCAN_QUEUE);
    if (steps > 0) console.log(`Queued ${steps} price change steps`);
    const reductions = await advanceLimitChanges(store, env.SCAN_QUEUE);
    if (reductions > 0) console.log(`Made ${reductions} announced reductions`);
  },

  /** Queue consumer: run each scan, and email its report if it was a scheduled one. */
  async queue(batch, env) {
    const store = createSupabaseStore(createAdminClient(env));
    const providers = createProviders(env, activeTuning.tuning);
    const strongerProviders = createStrongerProviders(env, activeTuning.tuning);
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

      const fit = SubscriptionFitMessageSchema.safeParse(message.body);
      if (fit.success) {
        const what = `Fitting the subscription of ${fit.data.fit_subscription} to its plan`;
        if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
          console.error(`${what} cannot run: the payment provider is not set up`);
          message.retry();
          continue;
        }
        try {
          const outcome = await fitSubscription(fit.data.fit_subscription, {
            store,
            payments: createStripePayments(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET),
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
            outside: { localOrigin: env.WORDPRESS_LOCAL_ORIGIN ?? null },
            hosting: hostingOf(env),
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

      const closing = ClosingMessageSchema.safeParse(message.body);
      if (closing.success) {
        const what = `Closing ${closing.data.closing_id}`;
        try {
          const outcome = await closeAccount(closing.data.closing_id, {
            store,
            key: await sealingKey(env.CONNECTIONS_KEY),
            send: env.RESEND_API_KEY
              ? (to: string[], email: Email) => sendEmail(env, to, email)
              : undefined,
            appUrl: env.APP_URL,
            outside: { localOrigin: env.WORDPRESS_LOCAL_ORIGIN ?? null },
            hosting: hostingOf(env),
            payments:
              env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
                ? createStripePayments(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET)
                : null,
          });
          console.log(`${what}: ${outcome}`);
          message.ack();
        } catch (error) {
          // Cloudflare not letting a subdomain go yet, for one: tried again in a few minutes.
          console.error(`${what} failed, will retry`, error);
          message.retry({ delaySeconds: 300 });
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
            outside: { localOrigin: env.WORDPRESS_LOCAL_ORIGIN ?? null },
            hosting: hostingOf(env),
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

      const draft = DraftMessageSchema.safeParse(message.body);
      if (draft.success) {
        const what = `Draft ${draft.data.draft_id}`;
        try {
          const outcome = await writeDraft(draft.data.draft_id, {
            store,
            sampleData: usesSampleData(env),
            // A deployment on sample data asks no model, whatever keys it holds.
            writer: usesSampleData(env) ? undefined : createLiveDraftWriter(env, activeTuning),
          });
          console.log(`${what}: ${outcome}`);
          // A page's copy, once written, is offered for publishing on the location's own site.
          if (outcome === "written") {
            const publishWith = await connectionToPublishWith(store, draft.data.draft_id);
            if (publishWith) {
              await env.SCAN_QUEUE.send({ connection_id: publishWith, step: "sync" });
            }
          }
          // A try that something got in the way of is made again in a minute, three times in all.
          if (outcome === "again") message.retry({ delaySeconds: 60 });
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
          strongerProviders,
          sampleProviders,
          weights: activeTuning.tuning.score,
          unavailable: liveScansUnavailable(env, activeTuning.source),
          sampleData: usesSampleData(env),
          // A deployment on sample data makes no real requests, so it does not fetch sites either.
          inspectSite: usesSampleData(env) ? undefined : fetchSite,
          geocode: createGeocoder(env),
          // Without a Resend key there is nobody to tell, so skip the owner lookup too.
          notify: env.RESEND_API_KEY
            ? async (report) => {
                const owners = await store.listOwnerEmails(report.location.organization_id);
                await sendEmail(env, owners, buildScanReportEmail(report, env.APP_URL));
                // With nobody to send to, what the report would have said is still to tell.
                return owners.length > 0;
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
  | DraftMessage
  | ClosingMessage
>;
