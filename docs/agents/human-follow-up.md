# Human follow-up

Required human actions left by completed agent work follow the procedure in the installed skills'
`human-follow-up` settings definition (for example
`.agents/skills/end-session/settings/human-follow-up.md`).

## Follow-up destination

`jwh3times/Nearcited` — one public issue per action, in the shape the open ones use (#121, #145:
Why, Scope as checkboxes, Done when, Depends on), with the step-by-step instructions in its body. A
follow-up whose text needs prompts, pricing, vendor terms, measured costs or a real business's name
goes to the `Private issue repository` instead
(`discover: git -C private remote get-url origin`), and nothing public references it.

## Follow-up label

`ready-for-human` (the companion has no such label yet: create it there on first use)

## Follow-up board

same as Board — `Gate` `Owner action` (`Owner decision` for a decision, `External` while waiting on
a third party), `Status` `Todo`, `Stage` the stage of the work it gates, else
`Decisions and upkeep`. A prerequisite is a native `blocked_by` dependency.

## Follow-up wiki

none — neither repository has a wiki (the feature is on, but no page was ever created); the
instructions live in the issue body.
