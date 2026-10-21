import type { Invitation, Member, MyInvitation } from "@nearcited/shared";
import { describe, expect, it } from "vitest";
import {
  anotherOwner,
  invitationHeadline,
  invitationLine,
  invitedNote,
  joiningNeeds,
} from "../src/lib/members";

const invitation = (extra: Partial<Invitation> = {}): Invitation => ({
  id: "1a000000-0000-4000-8000-000000000001",
  organization_id: "0a000000-0000-4000-8000-000000000001",
  email: "dave@example.com",
  role: "member",
  invited_by_email: "alice@example.com",
  created_at: "2026-10-20T09:00:00.000Z",
  sent_at: "2026-10-20T09:00:00.000Z",
  expires_at: "2026-11-03T09:00:00.000Z",
  ended_at: null,
  outcome: null,
  ...extra,
});

const member = (user_id: string, role: Member["role"]): Member => ({
  user_id,
  email: `${user_id}@example.com`,
  role,
  joined_at: "2026-10-01T09:00:00.000Z",
});

describe("an invitation on the owner's list", () => {
  it("is waiting until it expires, then expired, and declined once declined", () => {
    expect(invitationLine(invitation(), new Date("2026-10-21T09:00:00Z"))).toMatch(
      /^Waiting until /,
    );
    expect(invitationLine(invitation(), new Date("2026-11-04T09:00:00Z"))).toMatch(/^Expired on /);
    expect(
      invitationLine(
        invitation({ outcome: "declined", ended_at: "2026-10-22T09:00:00.000Z" }),
        new Date("2026-10-23T09:00:00Z"),
      ),
    ).toBe("Declined");
  });

  it("tells the owner to let the person know where no email went", () => {
    expect(invitedNote("dave@example.com", true)).toBe(
      "Invited dave@example.com. They have been sent an email.",
    );
    expect(invitedNote("dave@example.com", false)).toMatch(
      /no email could be sent\. Tell them to sign in to Nearcited with that address/,
    );
  });
});

describe("keeping an owner", () => {
  it("lets an owner step down only where another owner stays", () => {
    const people = [member("alice", "owner"), member("bob", "admin")];
    expect(anotherOwner(people, "alice")).toBe(false);
    expect(anotherOwner([...people, member("carol", "owner")], "alice")).toBe(true);
    // Anyone who is not an owner can always go.
    expect(anotherOwner(people, "bob")).toBe(true);
  });
});

describe("an invitation to the signed-in person", () => {
  const mine: MyInvitation = {
    id: "1a000000-0000-4000-8000-000000000001",
    organization_id: "0a000000-0000-4000-8000-000000000001",
    organization_name: "Raleigh Pizza Group",
    role: "admin",
    invited_by_email: "alice@example.com",
    expires_at: "2026-11-03T09:00:00.000Z",
  };

  it("says who invited them to what, as what", () => {
    expect(invitationHeadline(mine)).toBe(
      "alice@example.com invited you to Raleigh Pizza Group as an admin.",
    );
    expect(invitationHeadline({ ...mine, invited_by_email: null, role: "member" })).toBe(
      "An owner invited you to Raleigh Pizza Group as a member.",
    );
  });

  it("says what joining would take where they have an organization", () => {
    expect(joiningNeeds("Dave's Diner", true)).toMatch(/first close Dave's Diner .* deletes it/);
    expect(joiningNeeds("Dave's Diner", false)).toMatch(/first leave Dave's Diner/);
  });
});
