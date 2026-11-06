# Triage labels

The labels and what they mean are in `.agents/skills/ship/settings/triage-labels.md`. A skill's role name is the GitHub label to apply.

## Extra labels

- `blocked`: the issue cannot progress yet. It has an open blocker (a native issue dependency, the
  record of what blocks what), or it waits on an outside party or a condition nobody can act on now,
  such as Google's approval or enough businesses having done a kind of work. It sits beside one of
  the five state labels and replaces none: a `ready-for-agent` issue can be `blocked` until its
  blocker closes. Add it when a blocker is added, and remove it when the last one closes. Both
  trackers have it.
