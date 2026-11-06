# Human follow-up

Required human actions left by completed agent work follow the procedure in the installed skills'
`human-follow-up` settings definition (for example
`.agents/skills/end-session/settings/human-follow-up.md`).

## Follow-up board

same as Board — `Gate` `Owner action` (`Owner decision` for a decision, `External` while waiting on
a third party), `Status` `Todo`, `Stage` the stage of the work it gates, else
`Decisions and upkeep`, and `Priority` as `docs/agents/issue-tracker.md` defines it. A prerequisite
is a native `blocked_by` dependency, and the issue carries `blocked` while one is open.
