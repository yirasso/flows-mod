---
name: flows
description: How the Flows plugin works, for explaining it or planning with it. Use when the user asks how flows work, what a flow, step or run can do, where flows or their files live, or what they can ask for, outside a run or a draft in progress.
---

# Flows

Flows runs saved, repeatable automations: a **flow** is a list of steps, each handing its result to the next; each time it runs is a **run**. The plugin decides every step; the session's Claude carries it out through three tools:

- `mcp__flows__manage`: everything the person asks in plain words (open the pane, list, show, run, retry, stop, copy, rename, import, delete).
- `mcp__flows__next`: carries a started run, one answer at a time, until it says the run is over.
- `mcp__flows__draft`: writes or changes a flow with the person. Its `start` answer is the full writing guide; read it there, whenever a flow is written or changed.

The tools' answers say exactly what to do next: follow them rather than this page when running or writing.

## Where things live

- A flow is kept once, for every session, in `~/.claude/flows/<name>/`: `flow.json`, its scripts (`steps/*.js`), and `memory.md`.
- A run's files go to the folder of the session that runs it: `<folder>/Flows/<name>/runs/<n>/` (`run.json`, and each step's result in `out/`). Its agents work in that folder. A session with no folder lists and writes flows, but cannot run them.
- Flows from before version 0.9 sit in a project's own `Flows/` folder; `manage` lists them as not brought over, and `import` copies one.

## Steps

| Type | What it does | Its own fields |
| --- | --- | --- |
| `agent` | An AI worker: its own model, effort, instruction, role, time limit. | `schema` (its result's shape, checked; a misfit goes back to it `retries` times, 2 by default), `maxTokens`, `tools`, `remember` |
| `code` | A Node.js script for mechanical work; reads JSON on stdin, prints what it hands on; exit 3 ends the flow. | `file`, `seconds`, `schema`, `remember` |
| `approval` | Stops for the person: approve, approve with changes, approve every item at once, reject, send back to the agent before. | `show` (what they read, with `{{field}}` from the JSON it receives) |
| `each` | Splits a list and runs every later step once per item, each item on its own. One per flow. | `parallel` (3 by default), `max` (more items are cut, with a warning) |

The flow itself may have `inputs` (typed values asked when it starts: `{ id, description, type, required, default }`), `maxTokens` (a run past it stops), and `cwd` (another folder for its agents).

**Every step sees the whole run**: its input, the run's input, the flow's inputs, every earlier result, and the memory. A script gets them on stdin as `input`, `runInput`, `vars`, `outputs` (by step id), `memory`, `item`, `dry`, plus `flow`, `run`, `track`, `runDir`, `cwd`.

**Memory**: a step with `remember: true` adds its result to `memory.md`, read by every later run (leads already found, say).

## What can be asked for

- **Run** with an input or the flow's inputs; from a given step (`from`); as a **test run** (`dry`: no agent starts, each hands on a made-up result of its schema's shape, approvals pass, nothing is remembered, no tokens spent); in place of a run still going (`replace`, only once the person said so).
- **Take up** a stopped or failed run where it stopped, every failed item or one (`item`).
- **Stop** a run; stopping the chat stops it too.
- **Copy**, **rename**, **import**, **delete** a flow (delete asks first, and leaves the runs where they ran).
- **Change** some steps only: `draft` with `patch` and `remove`, which answers what changed.

Starting a run reports what its last finished run took. Ceilings are checked when a step ends. The commands (`/flows`, `/flows run <name> [input] [--test] [--new]`, `/flows retry <name> [item]`, `/flows new`, `/flows edit`, `/flows list`, `/flows delete`) do the same as plain words.

## The pane

Opened with `manage` `open`, `/flows`, or the Flows button above the prompt. It shows one flow at a time, picked from the card at the top; under it the run's time, tokens and share of the weekly limit, its warnings and folder, and one row per step. Everything else is asked in the chat.
