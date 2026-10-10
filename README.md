# Flows

A Claude Code plugin for saved, repeatable AI automations. You describe a flow in the chat, Claude writes it with you, and from then on you run it with one command and watch it in a pane.

A flow is a short list of steps: AI agents, Node scripts, approvals and a for-each. Each step hands its result to the next.

![The Flows pane: a run with its steps, and the eight costumes](docs/pane.png)

## Install

Flows needs Claude Code (the desktop app's Code tab, or the terminal) and Node.js, which runs the code steps.

```bash
claude plugin marketplace add yirasso/flows
claude plugin install flows@flows-local
```

Start a new session afterwards. Installing from GitHub has not been tried yet; the plugin has only run from a local folder.

## Commands

| Command | What it does |
| --- | --- |
| `/flow` | Opens or closes the pane. |
| `/flow <name>` | Shows that flow in the pane. Add a number to see an earlier run: `/flow <name> 2`. |
| `/flow new <name> <what it should do>` | Writes a new flow with you, in the chat. |
| `/flow edit <name> <what to change>` | Changes a flow. |
| `/flow run <name> [input]` | Runs a flow. The input is what its first step receives. |
| `/flow retry <name>` | Takes up a run that failed or was stopped, at the step where it stopped. |

A name takes lower-case letters, digits and hyphens. To stop a running flow, stop the chat.

## Writing a flow

```
/flow new page-summary summarise a web page in three points and save it to a file
```

Claude asks what it needs to know, in rounds of numbered questions, each with the answer it recommends. Then it proposes the flow. The steps appear in the pane as a draft, and the chat shows what was assumed, what was left out, and the code of any script. Nothing is saved until you choose Save.

## Running a flow

```
/flow run page-summary https://example.com/article
```

The chat does the running: Claude asks the plugin for the next step, starts the agent the plugin names, and asks again, until the flow is over. The plugin decides the steps and runs the scripts itself, so what one step hands the next does not pass through the chat.

- **Approvals** are asked in the chat: approve, reject, or send back to the agent with a note.
- **A failed step** stops the run. Claude says what failed and proposes one fix; with your yes, it makes the fix and takes the run up again at that step.
- **The chat is busy** while a flow runs.

## The pane

The pane only shows; everything is done from the chat. From top to bottom: the flow and its run, three tiles (what the run took of your weekly limit, its tokens, its time), the weekly limit, and one row per step.

Each agent step is a pixel crab in the costume of its role, and it moves while it works: researcher, writer, builder, designer, coder, reviewer, analyst, messenger. The other steps have their own drawing. In a terminal the pane is text.

## What a flow is made of

A flow is a folder in `~/Flows/<name>/`, with a `flow.json` and the scripts of its code steps. Each run gets a folder of its own under `runs/`, and the last ten are kept.

| Step | What it does |
| --- | --- |
| `agent` | An AI worker with its own model, effort, instruction, time limit and role. |
| `code` | A Node.js script, for work that needs no judgement. It reads `{ input, flow, run, track, runDir, cwd }` as JSON on stdin; what it prints is handed on. Exit code 3 ends the flow there. |
| `approval` | Stops until you answer in the chat. |
| `each` | Splits a list (JSON, or one item per line) and runs every step after it once per item, three at a time by default. One per flow. |

An agent may read files anywhere, search the web, and write inside the run's folder and the flow's working folder. Any other tool has to be listed in its step.

A small `flow.json`:

```json
{
  "description": "Summarises a web page in three points and saves them to a file.",
  "steps": [
    {
      "id": "summarise",
      "type": "agent",
      "name": "Summarise the page",
      "description": "Reads the page and writes its title and three points.",
      "role": "researcher",
      "model": "sonnet",
      "effort": "low",
      "instruction": "The input is the address of a web page. Read it and answer with one JSON object: {\"title\": \"...\", \"points\": [\"...\", \"...\", \"...\"]}."
    },
    {
      "id": "save",
      "type": "code",
      "name": "Save the file",
      "description": "Writes the summary as a Markdown file.",
      "file": "steps/2-save.js"
    }
  ]
}
```

## Limits

- **A flow runs inside a session.** Closing the session stops it; the run then shows as interrupted, and `/flow retry` takes it up again.
- **No schedules yet.** A flow starts by hand.
- **The week figure is approximate.** It is the weekly limit's percent used after the run minus before it, so other work in the same minutes counts too.
- **The plugin API is early access.** Function hooks may change between Claude Code releases.

## Develop

```bash
git clone https://github.com/yirasso/flows.git
cd flows
claude plugin validate .
claude plugin test .
```

| Path | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks, the two tools Claude calls, the command and the pane |
| `hooks/flow.ts` | The rules of a flow and of a run |
| `hooks/author.ts` | What Claude is told when writing a flow, and the check of what it proposes |
| `hooks/draw.ts` | The pane's drawings |
| `types/index.d.ts` | The plugin's state contract |
| `tests/` | Tests for the rules, a whole run, and writing a flow |

[SPEC.md](SPEC.md) records what was decided and why, including the two designs that were tried and dropped.

## Thanks

The way the characters are drawn (pixels on a grid, moved by CSS inside an SVG) follows the [savvy-progress](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress) mod by JohnnyVizz. The crab and its costumes were drawn from scratch for Flows.
