---
status: accepted
---

# On a business's own site, the product changes only what it made

Issue #140 lets the product write to a business's WordPress site once a member approves.
[0011](0011-the-product-does-the-work-and-the-owner-approves.md) settled that nothing changes
outside the product without a yes, and [0014](0014-only-the-worker-carries-out-an-action.md)
how a yes is carried out. A business's own site is different from a listing on a platform: its
owner writes on it too, often in a builder the product cannot see into, and what is on it is
theirs in a way a directory's fields are not. This record is how far the product's writing goes.

**The product adds; it does not edit what the owner wrote.** It may add the business details block
at the end of the home page, and (in the next step) publish new pages of its own. It never
rewrites or deletes the owner's text, and never touches menus, themes, plugins, other pages or an
SEO plugin's settings. What it adds is marked as its own, so it can be found again.

**It may change what it made, on approval.** When the details on file change, it proposes
updating its own block. The proposal shows the block that is there and the one that would replace
it, and nothing outside the marks is part of it.

**It reads the page again before writing, and compares only its own part.** What the member was
shown it would replace is the product's own block, or nothing. If someone changed that block
since, nothing is written and the action lapses as out of date. Anything else the owner wrote
meanwhile is kept, because the page is read again just before it is saved.

**A change it composed by rule is approved as it is.** The details block is built from what the
location holds and goes onto the site as markup. A member approves it or declines it; it is not
edited first, so nothing typed into a box goes onto the business's home page as code.

**Taking back is a new action that removes only what the action put there.** Any member may ask.
It is made already approved by whoever asked, as asking again after a failure is, and points at
the action it takes back, so the record keeps who asked for each. It puts back what was there
before only while what the action left is still there: if someone has changed it since, nothing
is written. It is refused for an action something later has changed, which is the one to take
back instead. The task the action marked done is no longer marked by it. A thing taken back is
not proposed again until what it rests on changes, as a thing that was declined is not.

## Considered options

- **Restore the whole page as it was before the action.** Rejected. It would undo whatever the
  owner wrote on the page since, unseen.
- **Rewrite the owner's copy where it would answer better.** Rejected for the first version. It
  is the owner's voice on their own site, and a page builder may keep the real text somewhere the
  interface does not show.
- **Put the block in a template, a widget or the site's footer**, where it would reach every
  theme and builder. Rejected: those are the site's design, not its content, and each theme keeps
  them differently. A home page that is the list of latest posts is offered no block; its owner
  keeps the block to paste.
- **Check the live page straight after writing, and take the block away if it does not show.**
  Rejected: caching plugins serve an old copy for a while, so a block that is there would be taken
  away. The next scan's on-page check says whether it shows.
- **Let taking back be a proposal a member then approves.** Rejected: it would ask the same person
  twice for one decision.

## Consequences

- A page built in a builder that keeps its layout outside the page's content, such as Elementor,
  may not show the block. The on-page check then still fails, and the Website tab says why that may
  be.
- An account that may not add a script, which is anyone but an administrator or an editor on an
  ordinary site, is offered no block: WordPress would strip it.
- Taking back needs the connection to be working and the plan to include it, like any action.
  Once a site is disconnected, what the product added is the owner's to remove in WordPress.
