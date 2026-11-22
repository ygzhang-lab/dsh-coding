/**
 * The delivery contract, split into the stage that owns each rule.
 *
 * Nothing here is a global system prompt: one fragment is injected as
 * per-step context for the stage actually in force, so the model reads the rule
 * it can act on now. That also keeps a long session from carrying every rule of
 * every stage in its system prompt.
 *
 * @module dsh-coding/contract
 */
import { stagePath, type CodingMode, type CodingStage } from './stages.js'

/** One paragraph per mode, injected with every stage fragment. */
export const MODE_CONTRACT: Readonly<Record<CodingMode, string>> = {
  auto:
    'Mode `auto`: the requirements stage decides the workflow for this request. Understand what the user is '
    + 'asking and inspect enough of the project to classify it: a question, explanation, or advice → `consult` '
    + '(also the fallback when the request is unclear or you are unsure); a review of existing behavior → '
    + '`review`; a change to the codebase → `codex`. Do not over-interpret the request, widen its scope, or '
    + 'design beyond it. State the chosen workflow in one line, call `coding_mode` with that mode, then follow '
    + 'the chosen mode\'s stages and rules. Auto opens only requirements; `coding_stage` cannot advance until '
    + 'a mode is chosen.',
  consult:
    'Mode `consult` (Q&A): answer the question directly. Give 1-3 options with tradeoffs, one '
    + 'recommendation, a short plan, and the decision you need from the user. Do not edit files, run '
    + 'tests, or create a todo list unless the user asks for implementation.',
  review:
    'Mode `review`: report concrete findings with `file:line` and a reproducible scenario, ordered by '
    + 'impact. Do not edit files unless the user explicitly asks for a fix; use the verify stage to '
    + 'check the claims you make.',
  codex:
    'Mode `codex`: inspect, plan the work, delegate the edit to the implement worker, verify the result, '
    + 'then deliver. The runtime enforces this order; a skipped gate is refused. The handoff recorded in '
    + 'requirements is the context every worker receives; keep it current instead of repeating history.',
}

/** The rule set owned by each stage. */
export const STAGE_CONTRACT: Readonly<Record<CodingStage, string>> = {
  requirements: [
    '### requirements — analyse the request and the ground truth',
    '- Read every applicable `AGENTS.md`, then the files the task touches. Never rely on remembered code.',
    '- Name the request before deciding: what the user wants, the deliverable, and the constraints. Ask only '
      + 'when a wrong guess would waste real work; otherwise record the assumption and keep moving.',
    '- Note the project state that matters to this request: entry points, existing patterns, the package '
      + 'manager, and the narrowest check that will prove the work.',
    '- Use `read`, `grep`, and `glob`; one inspection command is fine. Do not edit, plan, or verify yet.',
    '- Record the handoff with `coding_handoff({ goal, constraints, acceptance })` before advancing: codex '
      + 'cannot enter plan without a goal, and the planner only sees this text.',
    '- Advance with `coding_stage({"stage":"plan"})` once you can name the affected files; in `auto` mode, '
      + 'choose the workflow with `coding_mode` first.',
  ].join('\n'),
  plan: [
    '### plan — define done',
    '- Record what requirements established in the handoff: what the user asked for (goal, deliverable, '
      + 'constraints) and what the project actually looks like (entry points, patterns, checks). If either is '
      + 'missing, inspect now instead of guessing; a fact that stays in the conversation never reaches a worker.',
    '- Call `delegate_plan` when the work is more than a one-file edit: it explores read-only and returns '
      + 'single-purpose sub-tasks. For each task settle the boundary and handoff first: goal, files in scope, '
      + 'acceptance check, and what it must not touch. Order tasks so each depends only on earlier ones.',
    '- Every todo item and every planner task must name an observable acceptance check; record the definition '
      + 'of done with `coding_handoff({ acceptance: [...] })`. codex cannot enter verify without it.',
    '- Call `todo_write` with one verifiable item per task (3-6) and exactly one `in_progress`. Keep each '
      + 'implement brief self-contained so the worker\'s context and tokens stay bounded.',
    '- Choose the smallest approach: reuse existing functions, types, and patterns. Add no abstraction, '
      + 'dependency, or drive-by refactor the task does not need.',
    '- `coding_stage` refuses `implement` until the list is written.',
  ].join('\n'),
  implement: [
    '### implement — delegate the edit',
    '- You cannot edit files in this stage: `apply_patch`, `edit`, and `write` are not in your tool table.',
    '- Call `delegate_implement` with a self-contained task: goal, acceptance criteria, exact files, and '
      + 'the excerpts the worker needs. The worker has a fresh context and only the editing tools.',
    '- Pass the handoff\'s goal, constraints, and the current task\'s acceptance into the brief; do not make '
      + 'the worker re-derive them.',
    '- The worker returns a structured report (files, summary, notes). The runtime counts only reported '
      + 'edits toward the verify gate; you can inspect the files yourself in the verify stage.',
    '- One worker call per coherent change; split unrelated changes instead of batching them.',
  ].join('\n'),
  verify: [
    '### verify — prove it',
    '- Run the narrowest check first: `run_verification` with `scope:"targeted"`, then `package`, then '
      + '`full` when the change reaches across packages.',
    '- A behavior change needs a test that would have failed before it. `delegate_verify` investigates a '
      + 'failure without editing.',
    '- A task without an acceptance check cannot enter verify; record it with `coding_handoff` first.',
    '- The runtime caps fix/verify retries (`maxVerifyAttempts` / `maxSameFailure`). When the budget is '
      + 'exhausted, stop: advance to deliver and report a BLOCKED delivery naming the failing check, or ask the user.',
    '- Keep the task list current: mark a finished check completed with `todo_write`; the deliver gate '
      + 'reads recorded evidence, not the list.',
    '- A failing check means: go back to implement, fix it, verify again. The deliver gate reads the '
      + 'recorded verification result, so an unrun or failed check cannot be talked past.',
  ].join('\n'),
  deliver: [
    '### deliver — report compactly',
    '- Close the task list first: mark the finished items completed with `todo_write`, so no step stays '
      + 'in_progress after delivery.',
    '- Lead with the outcome: what changed and why. Then the files touched as backticked paths, the '
      + 'verification evidence (command and result), and residual risk.',
    '- If the last check failed and the retry budget is exhausted, this is a BLOCKED delivery: state the '
      + 'failing check, command, exit code, and last error; never claim success.',
    '- Do not dump diffs, logs, or large files; refer to paths. No step-by-step narration.',
    '- If something could not be verified, say what and why. Never report a passing check you did not run.',
  ].join('\n'),
}

/** One-line communication rule shared by every stage. */
export const COMMUNICATION_RULE =
  'Send at most one short sentence before a group of tool calls, and only when it helps. Do not narrate '
  + 'deliberation or restate tool output.'

/** Everything the model needs to know about the current state. */
export interface StageContextInput {
  readonly mode: CodingMode
  readonly stage: CodingStage
  readonly status: string
  /** Digest of the handoff the earlier stages recorded, when one exists. */
  readonly handoff?: string
  readonly rejection?: string
}

/**
 * Render the per-step context message. Kept terse: it rides in every request of
 * the session, so each line must earn its tokens.
 * @param input - mode, stage, and the rendered status line.
 * @returns the injected context text.
 */
export function stageContext(input: StageContextInput): string {
  const lines = [
    '## dsh-coding runtime (enforced by the plugin, not advice)',
    `${MODE_CONTRACT[input.mode]}`,
    `Stage path for this mode: ${stagePath(input.mode)}. Current stage: **${input.stage}**.`,
    `Status: ${input.status}`,
    ...input.handoff === undefined || input.handoff === ''
      ? []
      : ['', '## Handoff (recorded by earlier stages)', input.handoff],
    ...input.rejection === undefined ? [] : [`The last stage advance was refused: ${input.rejection}`],
    '',
    STAGE_CONTRACT[input.stage],
    '',
    COMMUNICATION_RULE,
  ]
  return lines.join('\n')
}
