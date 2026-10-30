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
  /** Each: the most items it takes; more are cut, with a warning on the run. */
  max?: number
  /** Agent or code: the shape its result must have, as a JSON Schema (type, properties, required, items, enum, min/max). */
  schema?: JsonSchema
  /** Agent with a schema: how many times it is asked again when its result does not fit (default 2). */
  retries?: number
  /** Agent: the most tokens it may use; past them the step fails. */
  maxTokens?: number
  /** Approval: what the person is shown, with {{field}} (or {{a.b}}) taken from the JSON it receives. */
  show?: string
  /** Agent or code: its result is added to the flow's memory, which every later run can read. */
  remember?: boolean
}

/** The part of JSON Schema a step's result is checked against. */
export type JsonSchema = {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  minItems?: number
  maxItems?: number
  minLength?: number
  minimum?: number
  maximum?: number
}

/** One input a flow asks for when it starts. */
export type FlowInput = {
  id: string
  description?: string
  /** `string` by default; `list` is a list of strings. */
  type?: 'string' | 'number' | 'boolean' | 'list'
  required?: boolean
  default?: string | number | boolean | string[]
}

/** A saved flow: `~/.claude/flows/<name>/flow.json`, or what is wrong with that file. */
export type Flow = {
  name: string
  description: string
  cwd?: string
  /** What it asks for when it starts; its run's input is then these values, as JSON. */
  inputs?: FlowInput[]
  /** The most tokens a run may use; past them it stops. */
  maxTokens?: number
  steps: FlowStep[]
  error?: string
}

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
  /** How many times its agent was asked again because its result did not fit the step's schema. */
  tries?: number
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

/** One run of a flow: `<session folder>/Flows/<name>/runs/<id>/run.json`. */
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
  /** The values of the flow's inputs it started with. */
  vars?: Record<string, unknown>
  /** A test run: no agent is started (each hands on a made-up result) and approvals pass by themselves. */
  dry?: boolean
  /** Things the person should know about it (more items than the flow takes, a ceiling reached). */
  warnings?: string[]
  /** The most tokens it may use, from its flow. */
  maxTokens?: number
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
