export interface FieldHelp {
  what: string
  examples: [string, string]
}

/** Explanations shown by the (i) button next to each graph setting. Every field of the New graph and Graph settings forms is covered, including the collapsed budgets section. */
export const graphHelp = {
  title: {
    what: 'A short name that identifies this graph in lists, inbox tasks and search.',
    examples: ['Grow monthly active users', 'Redesign onboarding']
  },
  description: {
    what: 'One line saying why the graph exists. It is shown under the name and given to agents as light context.',
    examples: ['Lift MAU 15% this quarter through campaigns and onboarding fixes', 'Ship the new onboarding and verify it with five users']
  },
  body: {
    what: 'The goal in plain words, with what "done" means. Decomposition agents split this into sub-goals, so name the outcome and any limits (budget, deadline, channels), not the steps.',
    examples: [
      'Increase monthly active users from 8,200 to 9,500 by 31 Dec using email and in-app prompts. No paid ads.',
      'Replace the signup flow with a three-step wizard and show at least 70% of five test users finishing it unaided.'
    ]
  },
  start_state: {
    what: 'The observed baseline: facts you measured today, not hopes. Plans and undo steps are judged against it, and a restoration check compares back to it.',
    examples: [
      'MAU 8,200 (Oct). Weekly email open rate 21%. Onboarding completion 38%. No in-app prompts exist.',
      'Signup is a single long form. 62% of visitors drop before the second field. No usability sessions run yet.'
    ]
  },
  predicates: {
    what: 'Statements that must be true for the goal to count as reached, one per line. Evidence from executed actions has to match them, so write them as checkable facts with a number or a place to look.',
    examples: [
      'October MAU report shows at least 9,500 active users\nOnboarding completion is 55% or higher over 14 days',
      'Five usability sessions are recorded in the research doc\nMedian task time for signup is under 90 seconds'
    ]
  },
  rule: {
    what: 'How the predicates combine. AND needs every predicate to hold. OR needs any one of them.',
    examples: ['AND: MAU target and onboarding target must both be met', 'OR: either the campaign or the redesign reaching its target is enough']
  },
  scope: {
    what: 'Where and when evidence counts: the environment, cohort or time window. Evidence from outside this scope is ignored when verifying the goal.',
    examples: ['Production · all users · last 30 days', 'Staging · new signups · week of 1 Dec']
  },
  agents: {
    what: 'Agents allowed to carry out actions. Tick the ones that may work in this graph. They must be separate from the grading agent, so the same agent never checks its own work.',
    examples: ['Tick ClaudeCode and OpenCode to run two actions at once', 'Tick only one agent for a careful, serial run']
  },
  decomposer: {
    what: 'The agent that breaks the goal into sub-goals and proposes plans. It reads context but does not execute actions.',
    examples: ['A reasoning-strong agent such as ClaudeCode', 'A cheap agent when goals are small and well defined']
  },
  grader: {
    what: 'The agent that independently scores executed results against the goal. It must differ from the execution agents.',
    examples: ['Gemini grading work done by ClaudeCode', 'A second Pi agent dedicated to grading']
  },
  fallback: {
    what: 'Optional agent used when a primary agent is offline or keeps failing. Leave as None to wait for the primary instead.',
    examples: ['OpenCode as backup for ClaudeCode', 'None: stalled work waits for the owner to decide']
  },
  capacity: {
    what: 'How many actions may run at the same time across agents.',
    examples: ['1: strictly one action at a time (safest)', '3: research, copy and analysis run in parallel']
  },
  threshold: {
    what: 'A number from 0 to 1. A candidate action is kept only when the agents are at least this confident it is needed for the goal. Higher means fewer, more essential actions.',
    examples: ['0.5: keep actions judged more likely needed than not', '0.8: keep only clearly necessary actions']
  },
  review: {
    what: 'Whether a person approves each agent result before the graph applies it. With review, every role holds its result in your inbox until you accept or reject it. Automatic acceptance applies valid results at once. With the 50% cutoff, the grader scores each execution before acceptance. Lower or unknown scores are rejected. Other valid role results are processed automatically.',
    examples: ['Require review: best for production changes and first runs', 'Accept automatically: low-risk research graphs you trust']
  },
  max_attempts: {
    what: 'How many times one assignment may be retried after a failure or bad format before it is blocked.',
    examples: ['3: two retries after the first try', '1: fail fast and ask a person']
  },
  attempt_budget: {
    what: 'Total attempts allowed across the whole graph. When it runs out, new work stops (recovery steps such as undo still run).',
    examples: ['100: room for a graph of about 20 actions', '30: a small experiment']
  },
  planning_budget: {
    what: 'Attempts reserved for planning and merging, so planning cannot use up the execution budget.',
    examples: ['20: enough for several decompose and merge rounds', '8: quick graphs with few sub-goals']
  },
  cost_budget: {
    what: 'Ceiling on the declared cost of actions that are executing. Each plan states a cost; actions are not started past this total.',
    examples: ['100: about ten actions costing 10 each', '20: a cautious cap while testing']
  },
  recovery_budget: {
    what: 'Cost kept aside for undo and reconcile steps, so a failed action can always be rolled back even when the main budget is spent.',
    examples: ['25: a quarter of the main budget', '10: small, easily reversible actions']
  },
  deadline_ms: {
    what: 'Minutes an agent may hold one assignment before the cloud treats it as stalled and starts recovery.',
    examples: ['30: typical for research and writing', '120: long builds or data jobs']
  },
  ttl_ms: {
    what: 'Hours a proposed (not yet published) action stays a candidate before it expires if nobody picks it up.',
    examples: ['24: proposals expire after a day', '72: weekend-proof for slower review']
  },
  maintenance_ms: {
    what: 'Minutes between background checks that time out stalled work, expire candidates and refresh the daily ledger.',
    examples: ['60: hourly housekeeping', '15: faster recovery for urgent graphs']
  },
  freshness_ms: {
    what: 'Hours for which evidence still counts. Older evidence must be collected again before the goal can be verified.',
    examples: ['24: metrics must be from the last day', '168: weekly reports are good enough']
  },
  section_goal: {
    what: 'The goal text for this graph, written by its owner. Agents split it into sub-goals. Collapse it when you only need the work below.',
    examples: ['Open: re-read what "done" means before approving a step', 'Collapsed: you are only triaging blocked tasks']
  },
  section_latest: {
    what: 'The most recent result an agent returned for this graph, in plain words, with a link to the inbox task it came from. It updates as the graph polls.',
    examples: ['A grader scored a step 0 because no evidence was supplied', 'An executor reported blocked: approvals are missing']
  },
  section_report: {
    what: 'A readable summary of what the graph did today: steps finished, what needs you, nodes that changed and budget used. The detailed list is under "Details".',
    examples: ['5 steps finished: 3 merge, 2 project. 1 needs you.', 'Budget: 86 of 10000 attempts, cost 500 of 10000']
  },
  section_proposals: {
    what: 'Candidate sub-goals drafted by a decompose step. Each waits for an independent merge review that decides if it is new (distinct), a duplicate, unsure or rejected. Only distinct ones join the graph.',
    examples: ['pending: the review has not run yet', 'uncertain: the reviewer was unsure, so it stays unpublished']
  },
  section_canvas: {
    what: 'The action graph. Goals and milestones guide planning. Violet dashed cards show proposed outcomes and solid cards show observations. Select an action edge for its plan or a node for its history. Click a card to inspect it, drag to rearrange, scroll to pan, Ctrl or Command with scroll to zoom.',
    examples: ['Click a milestone to see its evidence and linked inbox tasks', 'Highlighted amber cards need your reply']
  },
  section_work: {
    what: 'The work queue and history. Up next lists assignments by urgency (yours first); Activity is the event log.',
    examples: ['Needs you: a blocked step waiting on a reply', 'Activity: dispatched, accepted, rejected events in order']
  }
} satisfies Record<string, FieldHelp>

export type GraphHelpKey = keyof typeof graphHelp
