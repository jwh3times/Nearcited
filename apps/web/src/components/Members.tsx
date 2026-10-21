import {
  type Invitation,
  type InvitedRole,
  InviteInputSchema,
  invitationState,
  type Member,
  type MemberRole,
  MemberRoleSchema,
  type MyInvitation,
  type Organization,
  ROLE_MEANS,
} from "@nearcited/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { formatDay } from "../lib/billing";
import { useFormErrors } from "../lib/form";
import {
  anotherOwner,
  invitationHeadline,
  invitationLine,
  invitedNote,
  joiningNeeds,
  ROLE_NAMES,
} from "../lib/members";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";

interface MembersProps {
  organization: Organization;
  /** The signed-in person's role in it. */
  role: MemberRole | undefined;
  userId: string;
}

/**
 * Who is in the organization. Every member sees the list; an owner also invites, changes roles,
 * removes people and sees the invitations out. Anyone but the last owner may leave.
 */
export function Members({ organization, role, userId }: MembersProps) {
  const members = useQuery({
    queryKey: ["members", organization.id],
    queryFn: () => api.members(organization.id),
  });
  const owner = role === "owner";
  const people = members.data?.members ?? [];

  return (
    <section className="card settings-main" aria-label="Members">
      <div>
        <h2>Members</h2>
        <p className="small muted">
          Everyone here sees every location. A member can {ROLE_MEANS.member}; an admin can{" "}
          {ROLE_MEANS.admin}; an owner can {ROLE_MEANS.owner}.
        </p>
      </div>
      {members.isPending && <p className="status">Loading members</p>}
      <ErrorNote error={members.error} />
      <ul className="member-list">
        {people.map((member) => (
          <MemberRow
            key={member.user_id}
            organization={organization}
            member={member}
            owner={owner}
            mayGo={anotherOwner(people, member.user_id)}
            isMe={member.user_id === userId}
          />
        ))}
      </ul>
      {owner && members.data?.invitations && (
        <Invitations organization={organization} invitations={members.data.invitations} />
      )}
      {owner && <Invite organization={organization} />}
    </section>
  );
}

interface MemberRowProps {
  organization: Organization;
  member: Member;
  /** Whether the signed-in person is an owner, who may change this row. */
  owner: boolean;
  /** Whether another owner stays if this one steps down or goes. */
  mayGo: boolean;
  isMe: boolean;
}

function MemberRow({ organization, member, owner, mayGo, isMe }: MemberRowProps) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["members", organization.id] }),
      queryClient.invalidateQueries({ queryKey: ["me"] }),
    ]);
  const change = useMutation({
    mutationFn: (role: MemberRole) => api.changeRole(organization.id, member.user_id, role),
    onSuccess: refresh,
  });
  const go = useMutation({
    mutationFn: () =>
      isMe
        ? api.leaveOrganization(organization.id)
        : api.removeMember(organization.id, member.user_id),
    onSuccess: refresh,
  });
  const who = member.email ?? "Someone whose address is gone";
  // The last owner can neither step down nor go: the organization needs one.
  const mayChange = owner && (member.role !== "owner" || mayGo);
  const mayRemove = (owner || isMe) && (member.role !== "owner" || mayGo);

  return (
    <li className="member">
      <div>
        <p>
          {who}
          {isMe && <span className="muted"> (you)</span>}
        </p>
        <p className="small muted">Joined {formatDay(member.joined_at)}</p>
      </div>
      {mayChange ? (
        <select
          aria-label={`Role of ${who}`}
          value={member.role}
          disabled={change.isPending}
          onChange={(event) => change.mutate(MemberRoleSchema.parse(event.target.value))}
        >
          {MemberRoleSchema.options.map((role) => (
            <option key={role} value={role}>
              {ROLE_NAMES[role]}
            </option>
          ))}
        </select>
      ) : (
        <span>{ROLE_NAMES[member.role]}</span>
      )}
      {mayRemove &&
        (asking ? (
          <div className="closing-actions">
            <span className="small">
              {isMe
                ? `Leave ${organization.name}? You lose access at once.`
                : `Remove ${who}? They lose access at once.`}
            </span>
            <button
              type="button"
              className="danger"
              disabled={go.isPending}
              onClick={() => go.mutate()}
            >
              {isMe ? "Leave" : "Remove"}
            </button>
            <button type="button" className="secondary" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="secondary" onClick={() => setAsking(true)}>
            {isMe ? "Leave" : "Remove"}
          </button>
        ))}
      <ErrorNote error={change.error ?? go.error} />
    </li>
  );
}

/** The invitations an owner has out: waiting, declined or expired. */
function Invitations({
  organization,
  invitations,
}: {
  organization: Organization;
  invitations: Invitation[];
}) {
  if (invitations.length === 0) return null;
  return (
    <div>
      <h3 className="side-title">Invitations</h3>
      <ul className="member-list">
        {invitations.map((invitation) => (
          <InvitationRow key={invitation.id} organization={organization} invitation={invitation} />
        ))}
      </ul>
    </div>
  );
}

function InvitationRow({
  organization,
  invitation,
}: {
  organization: Organization;
  invitation: Invitation;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string>();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["members", organization.id] });
  const again = useMutation({
    mutationFn: () => api.sendInvitationAgain(organization.id, invitation.id),
    onSuccess: async ({ emailed }) => {
      setNote(invitedNote(invitation.email, emailed));
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelInvitation(organization.id, invitation.id),
    onSuccess: refresh,
  });
  const waiting = invitationState(invitation) === "waiting";

  return (
    <li className="member">
      <div>
        <p>{invitation.email}</p>
        <p className="small muted">
          {ROLE_NAMES[invitation.role]} · {invitationLine(invitation)}
        </p>
        {note && (
          <p className="small" role="status">
            {note}
          </p>
        )}
      </div>
      <div className="closing-actions">
        <button
          type="button"
          className="secondary"
          disabled={again.isPending}
          onClick={() => again.mutate()}
        >
          Send again
        </button>
        <button
          type="button"
          className="secondary"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {waiting ? "Cancel" : "Remove"}
        </button>
      </div>
      <ErrorNote error={again.error ?? cancel.error} />
    </li>
  );
}

/** An owner's form to invite an address as an admin or a member. */
function Invite({ organization }: { organization: Organization }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitedRole>("member");
  const [note, setNote] = useState<string>();
  const form$ = useFormErrors(InviteInputSchema, { email, role });
  const invite = useMutation({
    mutationFn: () => api.invite(organization.id, email, role),
    onSuccess: async ({ invitation, emailed }) => {
      setNote(invitedNote(invitation.email, emailed));
      setEmail("");
      await queryClient.invalidateQueries({ queryKey: ["members", organization.id] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (form$.check()) invite.mutate();
  }

  return (
    <form onSubmit={submit} className="invite" aria-label="Invite someone" noValidate>
      <h3 className="side-title">Invite someone</h3>
      <Field
        label="Email address"
        type="email"
        autoComplete="off"
        value={email}
        error={form$.error("email")}
        onBlur={() => form$.touch("email")}
        onChange={(event) => {
          setEmail(event.target.value);
          setNote(undefined);
          invite.reset();
        }}
      />
      <div className="field">
        <label>
          As
          <select
            value={role}
            onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "member")}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
      </div>
      <p className="small muted">
        They sign in with that address to accept. An invitation waits 14 days, and you can make
        someone an owner once they have joined.
      </p>
      <button type="submit" disabled={invite.isPending}>
        {invite.isPending ? "Inviting" : "Invite"}
      </button>
      {note && (
        <p className="small" role="status">
          {note}
        </p>
      )}
      <ErrorNote error={invite.error} />
    </form>
  );
}

/** Accept and Decline for an invitation to the signed-in person. */
function Answer({ invitation, mayAccept }: { invitation: MyInvitation; mayAccept: boolean }) {
  const queryClient = useQueryClient();
  const done = () => queryClient.invalidateQueries({ queryKey: ["me"] });
  const accept = useMutation({
    mutationFn: () => api.acceptInvitation(invitation.id),
    onSuccess: done,
  });
  const decline = useMutation({
    mutationFn: () => api.declineInvitation(invitation.id),
    onSuccess: done,
  });
  return (
    <>
      <div className="closing-actions">
        {mayAccept && (
          <button
            type="button"
            disabled={accept.isPending || decline.isPending}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? "Joining" : "Accept"}
          </button>
        )}
        <button
          type="button"
          className="secondary"
          disabled={accept.isPending || decline.isPending}
          onClick={() => decline.mutate()}
        >
          Decline
        </button>
      </div>
      <ErrorNote error={accept.error ?? decline.error} />
    </>
  );
}

/**
 * What someone with no organization sees in place of onboarding while an invitation waits for
 * them. Declining the last leads on to onboarding.
 */
export function InvitedPage({ invitations }: { invitations: MyInvitation[] }) {
  return (
    <main className="page-narrow">
      <h1>You are invited</h1>
      {invitations.map((invitation) => (
        <div key={invitation.id} className="card side-card">
          <p>{invitationHeadline(invitation)}</p>
          <p className="small muted">It waits until {formatDay(invitation.expires_at)}.</p>
          <Answer invitation={invitation} mayAccept />
        </div>
      ))}
      <p className="small muted">
        Declining every invitation takes you on to set up an organization of your own.
      </p>
    </main>
  );
}

/**
 * On the dashboard of someone who has an organization, the invitations waiting for them, and why
 * they cannot simply accept.
 */
export function InvitationNotices({
  invitations,
  organization,
  role,
  userId,
}: {
  invitations: MyInvitation[];
  organization: Organization;
  role: MemberRole | undefined;
  userId: string;
}) {
  // Whether they would have to close theirs, as its only owner, or could simply leave it.
  const members = useQuery({
    queryKey: ["members", organization.id],
    queryFn: () => api.members(organization.id),
    enabled: invitations.length > 0 && role === "owner",
  });
  const onlyOwner = role === "owner" && !anotherOwner(members.data?.members ?? [], userId);
  // Until it is known which, neither is said.
  const known = role !== "owner" || members.data !== undefined;
  return (
    <>
      {invitations.map((invitation) => (
        <div key={invitation.id} className="card side-card" role="status">
          <p>{invitationHeadline(invitation)}</p>
          {known && <p className="small muted">{joiningNeeds(organization.name, onlyOwner)}</p>}
          <Answer invitation={invitation} mayAccept={false} />
        </div>
      ))}
    </>
  );
}
