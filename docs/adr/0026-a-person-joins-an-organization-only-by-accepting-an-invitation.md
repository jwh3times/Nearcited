---
status: accepted
---

# A person joins an organization only by accepting an invitation to their own address

The roles (owner, admin and member) were in the schema from the start, but nobody could be added,
and the owner policies on `memberships` would have let the last owner remove or demote themselves.
Issue #10 settled how people come in and go.

**An owner invites an address, as an admin or a member.** Each invitation is a row of
`invitations`, written only by `invite_member()`, `send_invitation_again()` and
`cancel_invitation()`, which answer an owner of the organization and no one else, the operator
included. An owner is made only of someone who has joined. An invitation waits fourteen days from
when it was last sent, may be sent again once an hour, and an organization has at most twenty
waiting, so the email cannot be used to write to strangers. There is no seat limit.

**Signing in with the address is the proof.** There is no secret link. `accept_invitation()` and
`decline_invitation()` answer only the person signed in with the address it was sent to, in any
case, and the person always chooses: joining is never automatic. `my_invitations()` shows them
theirs. Nothing tells an owner, or anyone, whether an address already has an account.

**An account keeps one organization.** Accepting is refused while the person belongs to another,
on the terms `create_organization()` refuses a second. To join they leave theirs, or close it as
its only owner. An account with a platform role joins nothing: the operator changes a customer's
account only through its own functions, and a test account's organizations are never customers'.

**Who is in an organization changes only through functions that keep an owner.** The table's
insert, update and delete policies are gone and those grants revoked. `change_member_role()` and
`remove_member()` answer an owner, `leave_organization()` anyone in it, and each refuses a change
that would leave no owner, with the organization locked so two owners stepping down at once cannot
both pass. An organization may have several owners, all equal.

**The request sends the invitation's email.** Nothing is carried out or checked again later, and
no sign-in or connection is involved, so the queue would add a delay and no protection. A test
organization sends none, and where no email can go the invitation stands and the owner is told to
let the person know. Nobody is emailed about a join, a role change or a removal.

**Every member sees who is in it.** `organization_members()` gives each member's address, role
and when they joined, to members and the operator. Owners and the operator read the invitations.

## Considered options

- **Several organizations for one account, with a switcher.** Rejected for now: every page reads
  the first organization, and the one-account rule keeps a second free plan out of reach. Issue
  #11 is closed with this.
- **A secret link in the email.** Rejected: a link can be forwarded, and the address is already
  proven by signing in.
- **Admins invite too.** Rejected: whoever controls who is in the organization controls what
  everyone sees and does, and owners already hold billing, export and closing.
- **Send the email from the queue.** Rejected, as above.

## Consequences

- `Me` carries the caller's role in each organization and the invitations waiting for them.
- The export holds every invitation, accepted and cancelled ones included.
- Someone removed, or who leaves, keeps their sign-in and lands on onboarding; what they approved
  stays on the record.
