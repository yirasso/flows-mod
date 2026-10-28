/** What a step is: an AI agent, a Node script, a stop for the person's approval, or a split into one run per item. */
export type StepType = 'agent' | 'code' | 'approval' | 'each'

/** One step of a flow, as `flow.json` spells it. */
export type FlowStep = {
  /** Short id, unique in the flow (letters, digits, `-`). */
  id: string
  type: StepType
  name: string
  description?: string
  /** Agent: the role that picks its costume (researcher, writer, builder, designer, coder, reviewer, analyst, messenger). */
  role?: string
  /** Agent: `haiku`, `sonnet`, `opus` or a model id. */
  model?: string
  /** Agent: `low`, `medium`, `high`, `xhigh` or `max`. */
  effort?: string
  /** Agent: the most minutes it may run (default 30). */
  minutes?: number
  /** Agent: everything it has to do. */
  instruction?: string
  /** Agent: tools it may use besides reading, the web and writing in the flow's folders (`Bash`, `mcp__x__y`). */
  tools?: string[]
  /** Code: the script, relative to the flow's folder. */
  file?: string
  /** Code: the most seconds it may run (default 60, up to 600). */
  seconds?: number
  /** Each: how many items run at once (default 3). */
  parallel?: number
}

/** A saved flow: `~/Flows/<name>/flow.json`, or what is wrong with that file. */
export type Flow = { name: string; description: string; cwd?: string; steps: FlowStep[]; error?: string }

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed'

/** How one step went in one track of a run. */
export type StepRun = {
  status: StepStatus
  /** When it started (ms); also the token a late result is checked against. */
  startedAt?: number
  endedAt?: number
  agentId?: string
  tokens?: number
  /** The start of what it handed on. */
  preview?: string
  error?: string
  /** The note it was sent back with. */
  note?: string
}

/** One path through the steps: the main one, or one item of a for-each. */
export type Track = {
  /** The item's label; absent on the main track. */
  item?: string
  /** The first step this track runs. */
  from: number
  /** The step it is at. */
  at: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'ended'
  /** By step index. */
  steps: Record<string, StepRun>
}

export type RunStatus = 'running' | 'waiting' | 'failed' | 'done' | 'stopped' | 'interrupted'

/** One run of a flow: `~/Flows/<name>/runs/<id>/run.json`. */
export type Run = {
  id: number
  flow: string
  input: string
  status: RunStatus
  /** Why its failures are not plain failures: the person stopped it, or its session closed. */
  halt?: 'stopped' | 'interrupted'
  startedAt: number
  endedAt?: number
  /** The flow's steps as they were when the run started. */
  steps: FlowStep[]
  cwd?: string
  tracks: Track[]
  /** Why it ended before its last step. */
  ended?: string
  /** The weekly limit's percent used when it started and when it ended. */
  weekStart?: number | null
  weekEnd?: number | null
  /** The session running it, and when that session last said so (ms). */
  owner: string
  beat: number
}

/** What the pane shows: the chosen flow, and one of its earlier runs when asked for. */
export type View = { flow: string | null; run?: number }

/**
 * A flow being written or changed with the session's Claude: what the person asked, and, once proposed, the
 * flow and its scripts (by their path in the flow's folder), not saved yet.
 */
export type Draft = { name: string; mode: 'new' | 'edit'; ask: string; flow: Flow | null; files: Record<string, string> }

declare module 'claude-code' {
  interface PluginState {
    flows: {
      flows: Flow[]
      runs: Record<string, Run>
      view: View
      now: number
      /** The earlier run the pane shows, read from disk. */
      past: Run | null
      me: string
      draft: Draft | null
    }
  }
}
