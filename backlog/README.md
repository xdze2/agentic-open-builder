# Backlog

Ideas, issues and a record of what was done, kept in the repo next to the code. Written and read by the human and by the agent (Claude Code), so that a later session can pick an issue up without the chat history.

## Layout

```
backlog/
  README.md                 this file
  open/                     to do, or being worked on
    0002-belt-routing/
      issue.md              the issue
      prompt-hidden-wrap.png  images, screenshots, sketches it refers to
  done/                     finished; kept as a record of what was built and why
  discarded/                dropped; kept with the reason
```

- **One issue = one directory** `NNNN-short-slug/` with an `issue.md` and its images. A directory keeps the issue and its pictures together when it moves.
- **Number**: 4 digits, never reused, the next free number across all three folders (`ls backlog/*/ | sort | tail -1`). The slug is lowercase words joined by `-`.
- **Status = the folder.** Move the whole directory to change it: `git mv backlog/open/0002-belt-routing backlog/done/`. Also update `status:` in the header (below).

## `issue.md`

```markdown
---
title: Belt routing with waypoints
status: open            # open | done | discarded
created: 2026-11-13
closed:                 # date, when done or discarded
tags: [belt, solver]
related: [0001]         # other issue numbers
---

## Context
Why this matters, what we have now. Link files as [lib/belt.js](../../../lib/belt.js).

## Proposal
What to do. Options with a recommendation when there is a choice.

## Acceptance
- [ ] checkable outcomes ("node tools/solve.mjs user_data/assemblies/plotter.json reports ...")

## Log
- 2026-11-13: what happened, decisions, findings (newest last)

## Outcome
(done / discarded only) what was built, or why it was dropped.
```

Only `title`, `status`, `created` are required. Keep sections short; add others when useful.

## Images

- Put them in the issue directory and embed them with a relative path: `![belt hidden in the pulley hub](prompt-hidden-wrap.png)`. Always write what the image shows (caption or alt text): the agent reads the text first.
- Good sources: a prompt screenshot from `user_data/prompts/<stamp>/1.png` (copy it: `user_data/` is not in git), a snapshot from `node tools/snap.mjs user_data/assemblies/<file>.json --view iso --out <dir>` (crop the region of interest), or a sketch.
- Keep them small (crop, PNG, a few hundred KB at most).

## Conventions

- Write for someone who was not in the conversation: say which assembly, part instances, ports and numbers (mm) are involved.
- Refer to code and data by path, assemblies by file name (`plotter.json`), instances by name (`y_pulley`).
- When an issue is done, fill in **Outcome** with what changed (files, new JSON keys, docs) and how it was checked, then move it to `done/`.
- A discarded issue keeps its text; **Outcome** says why it was dropped and what replaced it, if anything.
- Asking the agent: "read backlog/open/0002-belt-routing/issue.md and do it", or "add an issue about ..." (it creates the next number in `open/`).
