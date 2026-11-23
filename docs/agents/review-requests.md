# Receipts, review requests and found answers

The project rules for receipts and customer contacts, review requests and opt-outs, and the
found answers counted on the way to the review form. `AGENTS.md` "Rules" points here, and
these bind as its own do: read this file before changing anything in this area.

- **Only the worker reads a customer contact in full, and a receipt is never guessed at.** A receipt
  copied to a location's receipt address reaches the Worker's `email` handler, which acts as the
  worker (`receiveEmail`, `apps/api/src/receipts.ts`). What a receipt says is decided by rule in
  `readReceipt` (`packages/shared/src/receipts.ts`): it counts only when Cloudflare's own
  `Authentication-Results`, the first one, says DKIM or SPF passed for the sender's own domain (or
  DMARC passed): a pass for another domain says nothing about who sent it. The customer is the single
  address in `To:` that is neither the business's own nor the product's. One that fails, names no
  customer or several, is from a declined sender or is for review requests that are not on is
  dropped and counted for its location (`receipt_drops`), and nothing else of it is kept. Only
  the customer's address and the job day, the `Date` in the location's time zone, are kept, by
  `receive_receipt()`, which only the worker calls. A receipt from a sender no owner or admin
  confirmed is held, and deleted after seven days; `confirm_receipt_sender()` and
  `decline_receipt_sender()` answer an owner or admin and no one else, the operator included.
  Nothing readable about a customer outlives its use: `drop_spent_contacts()`, which only the
  worker calls, deletes a contact thirty days after its request was sent, and one whose request
  ended unsent once the week after the job is over, and when a location's review requests are
  turned off, paused or removed, `stop_review_requests` deletes every contact of the location at
  once and lapses its requests still waiting (`turned_off`). A request that already took from the
  month is left to `finish_action()`. Keep both, and keep the fingerprints when a contact goes.
  `customer_contacts.address` is granted to no API role: every member and the operator read
  `masked` and the day, no route or wire type carries the address, and `export_organization()`
  leaves contacts out (`docs/adr/0031-a-customer-contact-is-read-only-by-the-worker.md`). Keep the
  column ungranted, select contacts by named columns, and log nothing of a message but what became
  of it. A test organization and a deployment on sample data receive nothing: their receipts are
  made up when the review requests sync (`sampleReceipts`), kept as `sample_data`. Only the worker
  proposes a review request from a contact (`propose_review_request()`) and sends it, and it sends
  nothing for a test organization, a made-up contact or a deployment on sample data. Whom an
  organization asked, who opted out of it, and which addresses bounced hard or complained, which no
  organization asks again, are kept only as a keyed fingerprint of the address (`asked_addresses`,
  `opted_out_addresses`, `stopped_addresses`, which no API role reads), never the address. An
  opt-out (`/api/opt-out/:token`) and the provider's report of a bounce or a complaint
  (`/api/resend/webhook`) arrive with no sign-in: the route checks the link's signature or the
  provider's first, reads nothing, queues only a fingerprint and answers the same for every
  address, and only the worker records them (`opt_out_address()`, `stop_address()`). The webhook
  reads a recipient's address only to fingerprint it, and keeps and logs none.
- **A found answer is counted by the worker, once a request, and nothing rests on it.** A review
  request's link to the review form is the product's, `/r/<token>`, signed under a key of its own,
  carrying the request's action, the form and the business's name, and never the address
  (`docs/adr/0033-a-found-answer-is-counted-on-the-way-to-the-review-form.md`). Its route has no
  sign-in and reads nothing: it checks the signature, makes the page from the link alone, queues
  the worker and sends every tap on to the form the link carries, and a link it did not sign gets
  the same page whatever is wrong with it. The page has no script, cookie or image, nothing of
  Nearcited's, no box to type in, and the way past the question with the answers' weight. Only the
  worker counts, through `record_found_answer()` and `record_found_opened()`, which only it calls:
  the first answer for a request and no later one (`found_answered`, which no API role reads), for
  the location by month and answer in `found_answers`, and nothing about who answered. The
  deployment's opens and go-ons are in `found_question_counts`, which only the operator reads. Never
  add the answers to `visits` or show their sum, and work no score, alert, task, report or bill out
  of them: anyone holding a link can tap anything. A request that went to nobody, for a test
  organization or on sample data, gets a made-up answer (`sampleFoundAnswer`), kept as
  `sample_data`. The token's format keeps working for as long as an email holding it may be opened:
  a new one takes a new version, and every earlier one is still read. Only requests the product
  sends carry the question; the request to send and the code to print keep the form's own link.
