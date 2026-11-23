# Members and closing an account

The project rules for members and invitations, and for closing or exporting an account.
`AGENTS.md` "Rules" points here, and these bind as its own do: read this file before changing
anything in this area.

- **Only the worker closes an account.** A request records an owner's ask through
  `request_closing()`, which answers an owner of the organization and no one else, refuses the
  operator, a test account and a name that is not the organization's, and queues the worker
  (`docs/adr/0020-the-worker-closes-an-account.md`). `closeAccount` (`apps/api/src/closing.ts`)
  cancels the subscription, removes every connection the way an owner's removal does, deletes the
  organization, then the owner's sign-in, then sends one email, writing each step on the closing's
  record so a retry carries on. Do not delete an organization or a sign-in anywhere else. From the
  ask the organization is out of its members' reach and the worker's schedule: keep that in the
  helpers every policy reads. `closings` is read by no API role, keeps the addresses only until
  the email has gone, and keeps the fingerprint of the owner's email only thirty days, which
  `create_organization()` checks so that closing is not a way to a second free first scan.
  Everything an organization holds is downloaded only through `export_organization()`, which
  answers only an owner, and never holds a sign-in, the operator's record of changes or what the
  providers were paid.
- **A person joins an organization only by accepting an invitation to their own address, and an
  organization always keeps an owner.** No API role writes `memberships`: `create_organization()`
  adds its maker, `accept_invitation()` adds the person signed in with the address an owner
  invited, and `change_member_role()`, `remove_member()` and `leave_organization()` change or
  remove one, each refusing a change that would leave no owner
  (`docs/adr/0026-a-person-joins-an-organization-only-by-accepting-an-invitation.md`). Invitations
  are written only by `invite_member()`, `send_invitation_again()` and `cancel_invitation()`, which
  answer an owner and no one else, the operator included; at most twenty wait at once, and one is
  sent at most once an hour. Accepting is refused while the person belongs to another
  organization, and to the operator and a test account. The invitation's email is sent by the request, and never for a test organization.
  Do not add a policy or grant that writes `memberships` or `invitations`, a link that joins by
  itself, or another way into an organization.
