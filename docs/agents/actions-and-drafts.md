# Actions and drafts

The project rules for actions, standing permission and drafts. `AGENTS.md` "Rules" points
here, and these bind as its own do: read this file before changing anything in this area.

- **Only the worker proposes an action, and only the worker carries one out.** A request records a
  member's yes or no (`approve_action()`, `decline_action()`, `retry_action()`) and queues the
  worker (`docs/adr/0014-only-the-worker-carries-out-an-action.md`). `carryOutAction`
  (`apps/api/src/actions/index.ts`) reads what is there before it writes: already as the action
  would make it is done, and no longer what the member was shown is out of date, and neither
  writes. Do not carry an action out on a request path, do not write through a connection
  anywhere else, and keep the read before the write. An organization's owners are told of every
  action within 48 hours: `claim_action()` refuses an organization one of whose actions has gone
  36 hours untold, and a yes is refused where no notice could be sent (`requireNotice`). Keep
  both, and mark an action told only when the email went, for a test organization, or on sample
  data with no email to send with. A kind of action has a row in `action_kind_terms`: the
  allowance it takes from, how many days what it replaced may be kept, and whether it can be taken
  back. `claim_action()` takes from the month and `finish_action()` gives it back when the thing
  was not done and marks the task the action did: take from or give back to the month nowhere
  else (a proposal may read what is spoken for, as `propose_review_request()` does), and add no
  path by which a member clears a task an action marked, but taking that action back. What an action read from outside is kept in `seen` and nowhere else, so
  that `drop_expired_seen()` can drop it on its day. On a business's own site an action adds or
  changes only what the product made, marked as its own, and compares only that part before it
  writes (`docs/adr/0018-on-a-business-site-the-product-changes-only-what-it-made.md`): never
  edit the owner's text, menus, themes or plugins. A change composed by rule is approved as it
  is (`EDITABLE_ACTION_KINDS`). Taking back is a new action made only by `take_back_action()`,
  which a member asks for, and it removes only what the action put there; a kind that cannot be
  taken back, such as a review request that was sent, is refused. Standing permission is
  a yes given in advance, and only `propose_action()` applies it, as an action is made;
  `claim_action()` checks it again and puts back to waiting what it no longer covers
  (`docs/adr/0025-standing-permission-is-checked-where-an-action-is-approved-and-carried-out.md`).
  It is given and ended only through `give_standing_permission()` and
  `end_standing_permission()`, which answer an owner or admin and no one else, the operator
  included, and it ends at a take-back of something done under it and when the plan stops
  including it. Keep both checks, never apply it to an action that `always_asks`, and add no
  other path that approves an action without a member.
- **Only the worker writes a draft, and a draft states nothing nobody gave.** A request records a
  member's ask (`ask_draft()`, which answers a member of the location's organization and no one
  else, the operator included) and queues the worker
  (`docs/adr/0016-the-worker-writes-a-draft.md`). `writeDraft` (`apps/api/src/drafts/index.ts`)
  reads the task, the page and the location off what is on file, so nothing a request said
  decides what a draft is written from. That is `DraftGiven` (`packages/shared/src/drafts.ts`) and
  nothing else: do not give a writer anything from the answers, or anything about the business a
  location does not hold. Every draft passes `factsNobodyGave` before it is kept, whatever wrote
  it, and one that fails twice is not kept. A writer only writes: it returns text, reports what
  each call used, and decides nothing. It is given no tools. A real draft is written only where
  the private tuning has instructions for its kind (`liveDraftKinds`, `apps/api/src/drafts/claude.ts`):
  the default tuning's are a placeholder, as its prompts are, so keep that too. What the writing
  used is recorded after every write (`recordUsage`, for the organization and no surface), kept
  or not. `claim_draft()` takes from the month and `finish_draft()` gives it back when nothing
  was written: count a draft nowhere else. Sample text is kept as `sample_data`, names no model
  and is never called a model's. Nothing on a request path writes `drafts`, and a draft is not
  written by opening a page.
