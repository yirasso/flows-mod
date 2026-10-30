# Flows: what was decided

Flows is a Claude Code plugin (a mod of function hooks) that runs saved multi-step AI flows and shows them in a pane. It replaces, for Tomás's own use, what the Nau app did with automations. Everything in the interface, the flows and the agents' instructions is in English. Decided with Tomás on 10 Oct 2026.

## What a flow is

- A saved, repeatable automation. Each time it runs is a run.
- **A flow is kept once, for every session; its runs go where the session is** (Tomás, 30 Oct 2026; from 10 Oct each project kept its own flows in its `Flows` folder, and before that they were in `~/Flows`). In `~/.claude/flows/<name>/` (`CLAUDE_CONFIG_DIR/flows` when that is set):
  - `flow.json`: the description, the inputs, the ceiling and the steps;
  - the code steps' files (for example `steps/2-filter.js`);
  - `memory.md`: what its `remember` steps handed on, run after run.
- Each run goes to the folder of the session that runs it, `<folder>/Flows/<name>/runs/<n>/`, with `run.json` and each step's output in `out/`; its agents work in that folder. The path is the one runs had before, so scripts that read other runs (pitch-kit reads scout-build's) still find them. A session with no folder can list, show and write flows, not run them.
- Only the plugin writes under `~/.claude/flows`; agents only read there (the memory), so none meets the question the session asks before a write under `.claude`, which is why flows had left `~/.claude` before.
- The flows of a project's old `Flows` folder are listed as not brought over; `manage` with `import` copies one (from that folder or any `path`). `copy` and `rename` work on the kept flows; a renamed flow's old runs stay under its old name.
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
- **An agent's result** goes into a file of the run (`out/<track>-<step>.txt`), which its task names. It hands back only the word DONE, so results do not pass through the chat. One that wrote no file is taken at what it handed back.
- **An agent that cannot do its task** hands back `FLOW-ERROR:` and why, and the step fails with that reason.
- **Every step sees the whole run** (Tomás, 30 Oct 2026, after a script could not see the count asked for and an agent was made to copy it along): an agent's task names the run's input, the values of the flow's inputs, the files of every earlier step's result and the memory; a script gets them on stdin (`runInput`, `vars`, `outputs` by step id, `memory`, `item`, `dry`).
- **Inputs:** a flow can list `inputs` (`{ id, description, type, required, default }`, typed string, number, boolean or list). The run's input is then their values as JSON; one that is needed and missing stops the start, saying which.
- **A result's shape:** an agent or code step can have a `schema` (a JSON Schema: type, properties, required, items, enum, minItems, maxItems, minLength, minimum, maximum). An agent's result that does not fit goes back to it with what is wrong, `retries` times (2 by default), then the step fails; a script's fails at once.
- **Ceilings:** `maxTokens` on an agent step fails it past that many tokens; on the flow, a run past it is stopped. Both are checked when a step ends. Starting a run says what its last finished run took.
- **Each:** `max` cuts the items it takes, with a warning on the run, shown in the pane and the chat (Tomás, 30 Oct 2026: 3 leads asked, 9 came, nobody noticed). An item that is a JSON object is labelled by its first text.
- **Memory:** a step with `remember: true` adds its result to the flow's memory (not in a test run), for every later run to read: the leads already found, say.

## How it runs

- **The plugin decides, the session's Claude carries out** (changed 10 Oct 2026, after two failed tries with the plugin starting the agents itself). `/flows run` hands the chat a prompt. Claude then calls the plugin's tool `mcp__flows__next`, does the one thing it answers, and calls it again, until the flow is over:
  - **start agents:** Claude starts the agents the answer names, with the Agent tool, in the background (changed 10 Oct 2026: a foreground agent holds the chat until it returns, so approvals waiting in the pane never reached the person). Claude calls the tool again at once, so an approval is put to the person while agents still work, and is woken when an agent finishes. The plugin's `agent.spawn` hook swaps in the step's real task and folder, so what one step hands the next never passes through the chat, and it refuses any agent that is no step waiting to start;
  - **approval:** Claude shows the person what they are approving and asks them in the chat, then brings their answer back to the tool;
  - **the end:** Claude reports the result, or what failed with a proposed fix.
- Scripts and for-each splits run inside the plugin, between two calls of the tool.
- **Items go each their own way:** after the "each", every item runs the steps after it on its own, up to `parallel` at once; its approval is asked as soon as it gets there. Only the starting of agents waits for the chat, since the session's Claude starts them.
- **Approvals** show what the step's `show` says (`{{field}}` from the JSON it receives), else that JSON laid out, cut at a line past 8,000 characters with the file named; with the item ("1 of 3"), how many wait, and the files. The answers: approve, `edit` (approve with the person's text handed on instead), `approve_all` (every item waiting at that step), reject, send back.
- **A test run** (`dry`, `/flows run <name> --test`) starts no agent: each agent step hands on a made-up result of its schema's shape, the approvals pass by themselves, the scripts run with `dry: true`, nothing is remembered.
- **Starting at a step** (`from`): the input stands for what the step before would have handed on; after the "each", it is the list of items.
- **A run still going** blocks a new one, unless the person says to start anew (`replace`, `/flows run --new`): it is stopped, then the new one starts.
- An agent's description names the run, the item and the step in words (`scout-build #3 · Padaria Sol (2/3) · step 5: Build site`); the spawn hook matches it word for word.
- After `/reload-plugins` the plugin forgets which agents it started; an agent's end is still taken as its step's result when the run has its id.
- **Why this way:** a flow then runs under the session's permission mode like any other work, Auto included. The savvy-progress mod works the same way.
- One run at a time per flow. Different flows run side by side.
- A failed step stops its track. `/flows retry <name>` takes the run up at the failed step, without repeating the steps before it; with an item's number, that item alone.
- Closing the session kills the agents. The run then shows as interrupted and can be retried.
- The last 10 runs of each flow are kept (pruning is not built yet).

## The pane

- **Only a picker of the flow shown** (Tomás, 28 Oct 2026): `hooks/picker.tsx`, a `Client` module drawn on the surface itself. The flow shown is a card (its last run's state and how long ago); a click or Enter opens the others under it, the running or waiting ones first, then by latest run, hovered rows lit; a pick reaches the plugin as a `ui.message`. A Select was tried first the same day and dropped as too plain; it stays where there is no `Client` (VS Code), and the mobile app, with neither, has one button per flow. Run, Stop, Retry, Edit, New and the older/newer runs were built as buttons on 26 Oct 2026 and dropped on 28 Oct: they are asked in the chat, in plain words or with the commands. The weekly limit bar was dropped the same day; the run's Week tile stays. A **Flows** button above the prompt opens and closes the pane, drawn above another mod's band (Claudify's), which stays whole under it. The commands stay, for the surfaces with no band or no input field (VS Code, mobile). From top to bottom: the flow buttons, the flow, the run's status (time, tokens, week ≈ x%), the steps.
- Each step is one row: its character, name, description, model, effort and progress.
- **Characters:** a pixel crab drawn from scratch as SVG, wearing the costume of the step's role, moving while it works. Eight roles: researcher, writer, builder, designer, coder, reviewer, analyst, messenger. Steps that are not agents have their own drawing. The technique follows the savvy-progress mod (MIT), which gets a thank-you in the README.
- Each finished step shows the start of what it handed on.
- **Week %:** the weekly limit's percent used when the run ended minus when it started, shown with "≈" (other work in the same period counts too).
- With the pane closed: a band above the prompt when a flow needs the person, and a short toast when one finishes.
- The look follows the Claudify plugin.

## The chat

- **Everything works in plain words** (Tomás, 27 Oct 2026; the commands stay, for those who prefer them). The plugin's tool `mcp__flows__manage` does what `/flows` does when the person asks in their own words: `open` and `close` the pane, `list` the flows, `show` one (or an earlier run), `run` one with its input (or `inputs`, `from`, `dry`, `replace`), `retry` (or one `item`), `stop`, `copy`, `rename`, `import`, `delete`. A name the person gave in their own words ("visitas espanha") brings back the project's flows with their descriptions, for Claude to pick the one meant or ask. `run` and `retry` hand no prompt to the chat, since Claude is already in its turn: the answer is the run's first step. `delete` first says what would go; it deletes only on a second call with `confirmed`, once the person said yes. Writing and changing a flow go through `mcp__flows__draft`, with or without `/flows new` and `/flows edit`.
- `/flows` opens and closes the pane.
- **`/flows new <name> <what it should do>`** and **`/flows edit <name> <what to change>`** hand the chat a prompt. Claude calls the plugin's tool `mcp__flows__draft`:
  - `start` answers how to write the flow: interview the person in rounds until at least 90% sure, what each step type is, and, for an edit, the flow as it is now with its scripts;
  - `propose` sends the whole flow, or a `patch` of the steps that change (and `remove`), made whole from the draft or the saved flow (Tomás, 30 Oct 2026: a whole flow sent again for one change, with no diff). The plugin checks it (`hooks/author.ts`) and shows it in the pane as a draft, with what changed from the saved flow, step by step; a fault goes back to Claude in words;
  - Claude then tells the person the steps, what it assumed and left out, shows the code of any script, and asks: Save, Change something, or Discard;
  - `save` writes `flow.json` and the scripts; `discard` drops the draft. Nothing is saved before the person says so.
- `/flows run <name> [input]`, `/flows retry <name>`, and `/flows <name> [run]`, which shows a flow in the pane, or one of its earlier runs (Tomás, 10 Oct 2026: no `show` word). `/flows list` lists the project's flows in the chat. `/flows delete <name>` says what would go (the steps, the scripts, the memory; the runs stay where they ran) and deletes only when typed again with `yes`; nothing brings a deleted flow back. A flow cannot be named list, new, edit, run, retry or delete.
- **Stopping a flow is stopping the chat** (Tomás, 10 Oct 2026: a `/flows stop` command was built and dropped, since a command typed while the chat works waits for the turn to end). The run shows as stopped, and `/flows retry` takes it up again.
- **When a run fails:** the tool tells Claude to say what failed and propose one fix, and to change nothing until the person agrees. The person is asked once: their yes to the fix is the yes to saving it (Tomás, 10 Oct 2026: a second "save?" question was built and dropped). Claude proposes the fixed flow with `agreed: true`, which saves it at once, and `mcp__flows__next` with `retry: true` takes the run up again at the failed step. A run goes on with a changed flow only if its steps are still the same ones (same ids and types, in order); otherwise it needs a new run.

## Build order

1. **The engine and a plain pane.** Done on 10 Oct 2026: the four step types, Run, Stop, approvals, retry, the test flow `test-facts`.
2. **The real pane.** Done on 10 Oct 2026 in `hooks/draw.ts`: the characters and their eight costumes, the three tiles, the weekly limit bar, one drawn row per step and per item, earlier runs with `/flows <name> <run>`, and only the last 10 runs kept. Left out: the band above the prompt (approvals and failures already come to the chat) and the "3/5" inside a step.
3. **The chat.** Done on 10 Oct 2026: `/flows new` with the interview, `/flows edit`, the draft in the pane, the failure report with a fix and the retry from the tool.

## What was tried first, and why it was dropped

- **The plugin starting the agents (`$.agent.spawn`).** In Auto mode the session refuses it: the classifier judges an action against the prompt that asked for it, and a plugin's spawn has none. No hook of the plugin is asked about its own spawn, and `$.tool.call` refuses the Agent and the Workflow tools. Outside Auto mode it ran a whole flow, with three faults: the person was asked before every write outside the project (the plugin's `tool.check` answer did not stop the question), every agent that ended woke the chat's model, and agents under `~/.claude` hit the sensitive-file question (hence `~/Flows`).
- **Each agent as its own `claude -p` process.** Not built: it needs the command-line login, which this machine does not have. It stays the fallback if Claude proves unreliable at following the tool.

## Seen in a real session, and still to see

- Seen (10 Oct 2026, in Auto mode): a whole run through the tool, the approval asked in the chat, the characters moving, the pane at the right width.
- Still to see: `/flows new` with a real interview, `/flows edit`, and a failed run fixed and taken up from the chat. From 0.9: the plugin's writes under `~/.claude/flows` asking nothing, a schema's retry, a test run, an approval answered with changes or for every item.
- Not built: schedules, the band above the prompt, the "3/5" inside a step.

## For whoever works on the code

- `hooks/flow.ts` holds the rules of a flow and a run, `hooks/author.ts` what Claude is told when writing a flow and the check of a proposal, `hooks/draw.ts` the pane's drawings: none has the engine in it. `hooks/register.tsx` has the hooks, the tools, the commands and the pane; `types/index.d.ts` the state contract.
- Check a change with `claude plugin validate .`, `claude plugin test .` and a typecheck. The `claude` binary the desktop app runs is under `%LOCALAPPDATA%\Claude-Data\claude_<id>\claude-code\<version>\<hash>\claude.exe` (before, `%APPDATA%\Claude\claude-code\...`).
- The plugin is installed from this folder (`flows@flows-mod`, the marketplace pointing at `C:\Dev\Flows`): an edit counts after `/reload-plugins`.
- In tests, the engine hands paths over with backslashes on Windows. A command's hook may not call `$.prompt.submit` (it holds the turn): the kickoff goes out from a timer.
