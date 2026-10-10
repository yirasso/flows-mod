# Flows: what was decided

Flows is a Claude Code plugin (a mod of function hooks) that runs saved multi-step AI flows and shows them in a pane. It replaces, for Tomás's own use, what the Nau app did with automations. Everything in the interface, the flows and the agents' instructions is in English. Decided with Tomás on 10 Oct 2026.

## What a flow is

- A saved, repeatable automation. Each time it runs is a run.
- Flows live outside this repository, in `~/.claude/flows/<name>/`:
  - `flow.json`: the description and the steps;
  - the code steps' files (for example `steps/2-filter.js`);
  - `runs/<n>/`: one folder per run, with `run.json` and each step's output in `out/`.
- The name is lower case, with hyphens, no spaces. It is also the folder's name.
- No tables. No schedules and no on/off in the first version: a flow starts by hand.

## Steps

A flow is a plain list, top to bottom. Each step receives what the one before handed on, and all of them share the run's folder.

| Type | What it does |
| --- | --- |
| `agent` | An AI agent with its own model, effort, instruction, time limit (30 min by default) and role. |
| `code` | A JavaScript file run with Node. It reads JSON on stdin (`input`, `flow`, `run`, `track`, `runDir`, `cwd`) and what it prints is handed on. 60 s by default. Exit code 3 ends the flow early, with the output as the reason. |
| `approval` | Stops until the person answers: Approve, Reject (the run ends there), or Send back with a note (the agent before runs again with the note). |
| `each` | Splits its input (a JSON list, or lines) into items. Every step after it runs once per item, up to 3 items at a time. One per flow. |

- **Models:** the AI picks one per step when it writes the flow: Haiku for simple work, Sonnet at medium effort by default, Opus for hard work.
- **What an agent may do alone:** read anywhere, search the web, and write inside the run's folder and the flow's working folder (`cwd`). Any other tool only if the step lists it in `tools`. Nothing is ever put to the person as a permission question: a call is allowed or refused.
- **An agent that cannot do its task** starts its answer with `FLOW-ERROR:`, and the step fails with that reason.

## How it runs

- The plugin is the engine. It starts each step's agent itself, waits for its answer, and hands the result to the next step.
- One run at a time per flow. Different flows run side by side.
- A failed step stops its track, with "Retry from here", which does not repeat the steps before it.
- Closing the session kills the agents. The run then shows as interrupted and can be retried.
- The last 10 runs of each flow are kept (pruning is not built yet).

## The pane

- From top to bottom: the flow picker, three tiles (week ≈ x%, tokens, time), the weekly limit bar, the buttons (Run with an input field, Stop, Delete) and the steps.
- Each step is one row: its character, name, description, model, effort and progress.
- **Characters:** a pixel crab drawn from scratch as SVG, wearing the costume of the step's role, moving while it works. Eight roles: researcher, writer, builder, designer, coder, reviewer, analyst, messenger. Steps that are not agents have their own drawing. The technique follows the savvy-progress mod (MIT), which gets a thank-you in the README.
- A click on a step shows what it handed on. A list shows earlier runs.
- **Week %:** the weekly limit's percent used when the run ended minus when it started, shown with "≈" (other work in the same period counts too).
- With the pane closed: a band above the prompt when a flow needs the person, and a short toast when one finishes.
- The look follows the Claudify plugin.

## The chat

- `/flow` opens and closes the pane.
- `/flow new <name> <description>`: Claude interviews the person until it is at least 90% sure what they want, then proposes the flow. The steps show in the pane as a draft (Save / Discard), and the chat says what was assumed, what was left out, and shows the code of any code step.
- `/flow edit <name> <change>`, `/flow run <name> [input]`, `/flow stop <name>`.
- **When a run fails:** a report goes to the chat by itself with a proposed fix, once per failure. The pane offers Apply & retry, Apply, or Discard. Another fix is asked for in the chat.

## Build order

1. **The engine and a plain pane.** Done on 10 Oct 2026: the four step types, Run, Stop, approvals, retry, the test flow `test-facts`.
2. **The real pane:** characters, tiles, week %, run history, the band and toasts.
3. **The chat:** `/flow new` with the interview, `/flow edit`, drafts, the error report with a fix.

## What phase 1 still has to show in the desktop app

A headless trial showed that the plugin registers a step's agent type, starts the agent, gets its id and hears its end. It could not go further: that command-line session was not signed in. Still to see in a real session:

- an agent's answer arriving and the flow moving on;
- whether Stop really stops a running agent (through the `TaskStop` tool);
- what happens to running agents when the person types in the chat;
- whether the weekly percent moves enough to measure one run.

## For whoever works on the code

- `hooks/flow.ts` holds the rules with no engine in them; `hooks/register.tsx` the hooks, the engine and the pane; `types/index.d.ts` the state contract.
- Check a change with `claude plugin validate .`, `claude plugin test .` and a typecheck. The `claude` binary is under `%APPDATA%\Claude\claude-code\<version>\<hash>\claude.exe`.
- The plugin is installed from this folder (`flows@flows-local`): an edit counts after `/reload-plugins`.
- In tests, the engine hands paths over with backslashes on Windows, and a spawned agent has no id in its answer: the plugin then finds it in `$.agent.list()` by its description.
