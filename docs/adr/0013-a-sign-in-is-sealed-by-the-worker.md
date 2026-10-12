---
status: accepted
---

# A connection's sign-in is sealed by the Worker and read only by the worker

[0011](0011-the-product-does-the-work-and-the-owner-approves.md) has the product keep an owner's
sign-in to their outside accounts: a Google profile, a website, the tool that holds their
customers. Those are secrets that belong to someone else, and whoever holds one can act as the
business in public. Issue #134 settled how they are kept.

**The Worker seals a sign-in before it reaches the database.** The key exists only as a Worker
secret, `CONNECTIONS_KEY`. Each sign-in is sealed with a fresh nonce, and the connection's ID is
authenticated with it, so a sealed sign-in moved to another connection's row does not open. A
copy of the database alone opens nothing, and neither does the key alone.

**It is kept in a table of its own that no API role can read.** `connection_secrets` has no
policy and no grant but the worker's. The connection's own row, which the organization's members
read, never holds it, and no route or wire type carries it, sealed or not.

**A request writes a sign-in and never reads one.** Connecting happens on a request, as the
owner or admin who asked: the Worker signs in, seals what it was given and hands the sealed text
to a function that checks who is calling. Everything that needs the sign-in afterwards is done by
the worker from the queue: syncing, acting, and taking back the access when the connection is
removed.

**Without the key nothing can be connected.** A deployment with no `CONNECTIONS_KEY` offers no
kind of connection, so a clone without secrets still runs. A value that is not a key fails
loudly: half a key is a mistake, not a weaker key.

**The record outlives the sign-in.** Removing a connection deletes its sign-in and everything
read from it. The row stays, with who connected it and who removed it, as the addresses they had
then.

## Considered options

- **Encrypting inside the database, with its vault.** Rejected. The key would sit beside what it
  protects, and whoever can read the database as its owner could open every sign-in. Sealed in
  the Worker, the database never sees the key or the plain text.
- **Letting a request read the sign-in when it has a reason to**, such as listing what an account
  can reach as soon as it is connected, or taking back access in the same request that removes
  it. Rejected. Every request acts as a signed-in user, and a path that can read a sign-in for one
  purpose can be made to read it for another. The cost is a wait of a few seconds after
  connecting, and a removal in two steps: asked for by the owner, finished by the worker, with the
  schedule asking again when a message is lost.
- **A column on the connection's row, kept back by a column grant.** Rejected. It is one mistaken
  grant or one `select *` from leaking. A table with no policy fails closed.
- **A key for each organization.** Not now. It guards against one organization's key leaking,
  which a single Worker secret cannot do by halves, and costs a key to keep for every
  organization. The sealed text carries a version, so the way of sealing can change later.

## Consequences

- Losing or changing the key makes every sign-in kept unreadable, and every owner signs in
  again. The key is kept in the password vault as well as on the Worker. Changing it on purpose
  means opening and sealing every sign-in again, which nothing does yet.
- The Worker is the one place where the key and the sealed text meet. The database's secret key
  can read sealed text and cannot open it.
- A sign-in the Worker cannot open is still deleted when its connection is removed: the owner
  asked for it gone, and the access it gave cannot then be taken back at the outside service.
- Removing takes two steps, so a connection can be seen "being removed" for a moment, and one
  whose message is lost waits for the next run of the schedule.
- The sample connection, on sample data and for test organizations, is sealed and removed the
  same way, so the path is exercised with no outside account.
