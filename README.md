<div align="center">

# Flows

**Saved, repeatable AI automations for Claude Code: describe one in the chat, run it with one command, watch it step by step in a pane.**

A flow is a short list of steps (AI agents, Node scripts, approvals and a for-each) where each step hands its result to the next. Claude writes it with you once; from then on it runs the same way every time.

[![Version](https://img.shields.io/github/package-json/v/yirasso/flows-mod?filename=.claude-plugin%2Fplugin.json&label=version&color=D97757)](.claude-plugin/plugin.json)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.claude.com/en/docs/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#requirements)

<img src="docs/pane.png" alt="The Flows pane during a run of a flow named page-summary: the run's share of the week, its tokens and its time, the weekly limit, and six steps. Four are done (an agent, a script, an approval and a for-each), a writer agent is summarising three pages at once, and a reviewer waits its turn" width="620">

</div>

## Why

Asking Claude for the same multi-step job twice gives two different jobs: other steps, other models, other prompts, and no record of what each part did. A flow fixes the steps once. Each agent has its own model, effort, instruction and time limit; the parts that need no judgement are plain scripts that run **in code, with no model**; and nothing goes past an approval without your answer.

## How it works

### Write it once

```
/flow new page-summary find the best pages about a topic and summarise each one into a file
```

Claude interviews you in rounds of numbered questions, each with the answer it recommends, until it is sure of what you want. Then it proposes the flow: the steps appear in the pane as a draft, and the chat shows what was assumed, what was left out, and the code of every script. **Nothing is saved until you say so.**

### Run it

```
/flow run page-summary volcanoes
```

The plugin decides each step and runs the scripts itself; the session's Claude only starts the agents the plugin names and puts the approvals to you. What one step hands the next travels through files, not through the chat.

- **Approvals** are asked in the chat: approve, reject, or send back to the agent with a note.
- **A failed step** stops the run. Claude says what failed and proposes one fix; with your yes, it makes the fix and takes the run up again at that step.
- **Stopping the chat stops the flow.** `/flow retry` takes it up where it stopped.
- **It works in Auto mode**, with no permission prompts along the way.

### The steps

| Step | What it does |
| --- | --- |
| `agent` | An AI worker with its own model, effort, instruction, time limit and role. |
| `code` | A Node.js script, for work that needs no judgement. It reads `{ input, flow, run, track, runDir, cwd }` as JSON on stdin; what it prints is handed on. Exit code 3 ends the flow there. |
| `approval` | Stops until you answer in the chat. |
| `each` | Splits a list (JSON, or one item per line) and runs every step after it once per item, three at a time by default. One per flow. |

### The cast

Every agent step is a pixel crab in the costume of its role, and it moves while it works.

<div align="center">
<img src="docs/roles.png" alt="The eight roles, each a pixel crab in costume: researcher, writer, builder, designer, coder, reviewer, analyst and messenger" width="820">
</div>

## Commands

| Command | What it does |
| --- | --- |
| `/flow` | Opens or closes the pane. |
| `/flow list` | Lists the project's flows: what each does and how its last run went. |
| `/flow <name>` | Shows that flow in the pane. Add a number to see an earlier run: `/flow <name> 2`. |
| `/flow new <name> <what it should do>` | Writes a new flow with you, in the chat. |
| `/flow edit <name> <what to change>` | Changes a flow. |
| `/flow run <name> [input]` | Runs a flow. The input is what its first step receives. |
| `/flow retry <name>` | Takes up a run that failed or was stopped, at the step where it stopped. |
| `/flow delete <name>` | Deletes a flow, its scripts and its runs. It says what goes first, and deletes when you repeat it with `yes`. |

A name takes lower-case letters, digits and hyphens.

## The pane

The pane only shows; everything is done from the chat. From top to bottom: the flow and its run, three tiles (what the run took of your weekly limit, its tokens, its time), the weekly limit, and one row per step with its state, its time and tokens, and the first line of its result. The items of a for-each sit under their step. In a terminal the pane is text.

## Where flows live

A flow belongs to a project. It is a folder in the project the session is open in, `Flows/<name>/`, with a `flow.json` and the scripts of its code steps:

```
Flows/
  page-summary/
    flow.json
    steps/2-unique.js
    runs/3/        one folder per run; the last ten are kept
```

To use a flow in another project, copy its folder there. The flows can go in git with the project; add `Flows/*/runs/` to its `.gitignore`.

<details>
<summary>A small <code>flow.json</code></summary>

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

</details>

## Install

In Claude Code:

```bash
/plugin marketplace add yirasso/flows-mod
/plugin install flows@flows-mod
```

Then start a new session (or run `/reload-plugins`) and type `/flow`.

## Requirements

| Needed for | Tool |
| --- | --- |
| Everything | [Claude Code](https://docs.claude.com/en/docs/claude-code), in the desktop app's Code tab or the terminal |
| Code steps | [Node.js](https://nodejs.org) |

Flows is tested most on **Windows** in Claude Desktop; macOS and Linux are supported but less exercised.

## Models and privacy

Flows calls a model only through Claude Code itself, on your own account:

| When | Model |
| --- | --- |
| Writing or changing a flow, and carrying a run from step to step | Your session's model |
| Each agent step | The model and effort that step names |
| Code steps, approvals, the for-each, the pane | None |

Nothing is sent anywhere else. Two things to know before you run a flow someone else wrote:

- **An agent** may read files anywhere, search the web, and write inside the project. Any other tool has to be listed in its step.
- **A code step** is an ordinary Node.js script: it runs with your rights, with no sandbox. Read it first, the same as any script.

## Limits

- **A flow runs inside a session.** The chat is busy while it runs, and closing the session stops it; `/flow retry` takes it up again.
- **No schedules yet.** A flow starts by hand.
- **The week figure is approximate.** It is the weekly limit's percent used after the run minus before it, so other work in the same minutes counts too.
- **The plugin API is early access.** Function hooks may change between Claude Code releases.

## Develop

```bash
git clone https://github.com/yirasso/flows-mod.git
cd flows-mod
claude plugin validate .
claude plugin test .
```

Load your working copy with `claude --plugin-dir <path to the clone>`.

| Path | What it is |
| --- | --- |
| `hooks/register.tsx` | The hooks, the two tools Claude calls, the command and the pane |
| `hooks/flow.ts` | The rules of a flow and of a run |
| `hooks/author.ts` | What Claude is told when writing a flow, and the check of what it proposes |
| `hooks/draw.ts` | The pane's drawings |
| `types/index.d.ts` | The plugin's state contract |
| `tests/` | Tests for the rules, a whole run, and writing a flow |

[SPEC.md](SPEC.md) records what was decided and why, including the two designs that were tried and dropped. Issues and pull requests are welcome.

## Thanks

The way the characters are drawn (pixels on a grid, moved by CSS inside an SVG) follows the [savvy-progress](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress) mod by JohnnyVizz. The crab and its costumes were drawn from scratch for Flows.

## License

[MIT](LICENSE) © Tomas Girao
