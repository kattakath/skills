export const meta = {
  name: 'plan-pipeline',
  description: 'Design a scrape-harness pipeline.toml for an objective: 3 independent stage plans, deterministic rule checks, adversarial review, one judged draft. Plans only; never runs or fetches.',
  whenToUse: 'After site-recon, when a consumer needs its stages, I/O and network classes declared. Pass args: {objective, site, notes}.',
  phases: [
    { title: 'Design', detail: '3 independent stage plans from different angles' },
    { title: 'Check', detail: 'deterministic pipeline.v1 rules, then 2 adversarial reviewers per plan' },
    { title: 'Judge', detail: 'pick one, graft the best of the others, list operator questions' },
  ],
}

// Rules of pipeline.v1 the plan must satisfy; checked here in plain code, not by an agent.
const NAME = /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?$/
const ENTRY = /^(@[a-z][a-z0-9_]*|(DATA|STATE|OLD|stdout):.+)$/
const KIND = /^[a-z][a-z0-9_]*$/
const SCHEMA_NAME = /^[a-z][a-z0-9_-]*\.v[0-9]+$/
const NETWORK = ['none', 'site', 'paid']
const UTILITIES = [
  ['ab', 'site', [], ['DATA:derived/ab-{ab_at}.json', '@run']],
  ['crawl resume', 'site', ['STATE:crawlee/request_queues/{queue}', 'DATA:runs/{run_file}.json'], ['@run']],
  ['migrate', 'none', ['OLD:every file'], ['DATA:data files', 'STATE:state files']],
  ['cooldown', 'none', ['DATA:events.jsonl'], ['DATA:events.jsonl']],
  ['approve', 'none', [], [], true],
  ['browser open', 'site', [], [], true],
]

const STAGE = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    network: { type: 'string', enum: NETWORK },
    purpose: { type: 'string' },
    args: { type: 'array', items: { type: 'string' } },
    inputs: { type: 'array', items: { type: 'string' } },
    outputs: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'network', 'purpose', 'inputs', 'outputs'],
}
const PLAN = {
  type: 'object',
  properties: {
    angle: { type: 'string' },
    stages: { type: 'array', items: STAGE },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: { type: 'string' }, path: { type: 'string' }, schema: { type: 'string' } },
        required: ['kind', 'path', 'schema'],
      },
    },
    requests_estimate: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['angle', 'stages', 'files', 'requests_estimate', 'risks'],
}
const REVIEW = {
  type: 'object',
  properties: {
    fatal: { type: 'array', items: { type: 'string' } },
    fixable: { type: 'array', items: { type: 'string' } },
  },
  required: ['fatal', 'fixable'],
}
const VERDICT = {
  type: 'object',
  properties: {
    winner: { type: 'integer' },
    why: { type: 'string' },
    final: PLAN,
    operator_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['winner', 'why', 'final', 'operator_questions'],
}

const a = args || {}
const brief = [
  `Objective: ${a.objective || '(none given — say so and plan the smallest useful pipeline)'}`,
  `Site: ${a.site || '(unspecified)'}`,
  a.notes ? `Notes: ${a.notes}` : '',
].filter(Boolean).join('\n')

const RULES = `You design a scrape-harness pipeline.toml (schema pipeline.v1). You PLAN ONLY: never fetch the site, never run the
CLI with a networked command, never write files. Read what exists in this project first: pipeline.toml, the Source
module(s), the record schemas, and any site-recon notes.
Rules:
- stages run in order; each stage: name (lowercase, hyphens, at most two words), network none|site|paid, inputs/outputs
  as "ROOT:path" (ROOT = DATA, STATE, OLD or stdout; {run_file} {queue} {site} {ads} {sample_file} {plan_hash} are
  filled at run time) or "@run" (the run record, live log, events and queue);
- every DATA input of a stage is produced by an EARLIER stage or is explicitly an import the operator provides;
- every networked stage that fetches detail pages also keeps raw snapshots, and a later offline "reparse" stage exists,
  so a parser fix never needs the network again;
- the fewest requests that answer the objective: list pages before detail pages, sampling over full crawls,
  no networked stage after an analysis stage;
- data files are JSONL with a named record schema (kind -> path + "<name>.v<N>").`

phase('Design')
const ANGLES = [
  'MINIMAL REQUESTS: the smallest number of page views that can answer the objective, even at lower coverage.',
  'RISK FIRST: the plan least likely to trip challenges or rate limits, with stops and resumable stages early.',
  'ANALYSIS FIRST: start from the question the data must answer and derive backwards which records are needed.',
]
const drafts = await parallel(ANGLES.map((angle, i) => () =>
  agent(`${RULES}\n\n${brief}\n\nYour angle: ${angle}\nReturn one complete plan.`,
    { label: `design:${i + 1}`, phase: 'Design', schema: PLAN })))

function ruleErrors(p) {
  const errs = []
  const produced = new Set()
  const seen = new Set()
  p.stages.forEach((s, i) => {
    if (!NAME.test(s.name)) errs.push(`stage ${i + 1}: name "${s.name}" is not pipeline.v1`)
    if (seen.has(s.name)) errs.push(`stage "${s.name}" declared twice`)
    seen.add(s.name)
    for (const e of [...s.inputs, ...s.outputs]) if (!ENTRY.test(e)) errs.push(`${s.name}: entry "${e}" is not ROOT:path or @group`)
    for (const e of s.inputs) {
      if (e.startsWith('DATA:') && !produced.has(e) && !/import/i.test(s.purpose)) errs.push(`${s.name}: input ${e} is produced by no earlier stage`)
    }
    for (const e of s.outputs) produced.add(e)
  })
  const fetches = p.stages.findIndex(s => s.network !== 'none' && s.outputs.some(o => o.startsWith('DATA:raw/')))
  if (fetches >= 0 && !p.stages.slice(fetches + 1).some(s => s.network === 'none' && /reparse/.test(s.name)))
    errs.push('detail pages are snapshotted but no later offline reparse stage exists')
  const lastNet = p.stages.map(s => s.network !== 'none').lastIndexOf(true)
  const firstAnalysis = p.stages.findIndex(s => s.network === 'none' && !/reparse/.test(s.name) && s.inputs.length)
  if (firstAnalysis >= 0 && lastNet > firstAnalysis) errs.push('a networked stage runs after an analysis stage')
  for (const f of p.files) {
    if (!KIND.test(f.kind) || !SCHEMA_NAME.test(f.schema) || !f.path.endsWith('.jsonl')) errs.push(`file ${f.kind}: kind/path/schema not pipeline.v1`)
  }
  return errs
}

phase('Check')
const checked = await pipeline(
  drafts.map((d, i) => ({ d, i })),
  ({ d, i }) => {
    if (!d) return null
    return { d, i, rules: ruleErrors(d) }
  },
  r => r && parallel(['politeness and request count', 'data flow and reproducibility'].map(lens => () =>
    agent(`${RULES}\n\n${brief}\n\nTry to REFUTE this plan through the lens of ${lens}. Report what is fatal (the plan must not be used) and what is fixable. Plan:\n${JSON.stringify(r.d)}\nDeterministic rule errors already found: ${JSON.stringify(r.rules)}`,
      { label: `review:${r.i + 1}:${lens.split(' ')[0]}`, phase: 'Check', schema: REVIEW })))
    .then(reviews => ({ ...r, reviews: reviews.filter(Boolean) })),
)
const viable = checked.filter(Boolean)
for (const c of viable) log(`plan ${c.i + 1} (${c.d.angle.slice(0, 40)}): ${c.rules.length} rule errors, ${c.reviews.flatMap(x => x.fatal).length} fatal`)
if (!viable.length) return { error: 'no plan was produced', drafts }

phase('Judge')
const verdict = await agent(
  `${RULES}\n\n${brief}\n\nYou judge ${viable.length} candidate plans with their deterministic rule errors and adversarial reviews. ` +
  `Pick the plan with no rule errors and no unaddressed fatal finding that answers the objective with the fewest requests; ` +
  `graft fixable improvements from the others; fix every rule error. List the decisions only the operator can make ` +
  `(scope, rate, sample size, which site areas) as operator_questions.\n` +
  JSON.stringify(viable.map(c => ({ index: c.i, plan: c.d, rule_errors: c.rules, reviews: c.reviews }))),
  { label: 'judge', phase: 'Judge', schema: VERDICT })

const final = verdict.final
const remaining = ruleErrors(final)

const q = s => JSON.stringify(s)
const toml = [
  '# DRAFT from /scrape-harness:plan-pipeline. Review it, add [consumer] (and [plugins] if the source is',
  '# not an installed package), check it loads (`<cli> claude-settings`), then record the goldens deliberately.',
  'schema = "pipeline.v1"',
  `name = ${q(a.name || 'draft')}`,
  'offline_flags = ["--dry-run", "--driver fixture"]',
  'plan_outputs = ["STATE:plans/{plan_hash}.json"]',
  '',
  '[groups]',
  'run = ["DATA:runs/{run_file}.json", "DATA:runs/{run_file}.log.jsonl", "DATA:events.jsonl", "STATE:crawlee/request_queues/{queue}"]',
  '',
  ...final.stages.flatMap(s => [
    `# ${s.purpose.replace(/\n/g, ' ')}`,
    '[[stages]]',
    `name = ${q(s.name)}`,
    `network = ${q(s.network)}`,
    ...(s.args && s.args.length ? [`args = ${q(s.args)}`] : []),
    `inputs = ${q(s.inputs)}`,
    `outputs = ${q(s.outputs)}`,
    '',
  ]),
  // the harness's own commands, outside the stage order (same for every consumer)
  ...UTILITIES.flatMap(([name, network, inputs, outputs, op]) => [
    '[[utilities]]', `name = ${q(name)}`, `network = ${q(network)}`, ...(op ? ['operator_only = true'] : []),
    `inputs = ${q(inputs)}`, `outputs = ${q(outputs)}`, '',
  ]),
  ...final.files.flatMap(f => [`[files.${f.kind}]`, `path = ${q(f.path)}`, `schema = ${q(f.schema)}`, '']),
].join('\n')

return {
  toml,
  rule_errors_remaining: remaining,
  winner: verdict.winner,
  why: verdict.why,
  requests_estimate: final.requests_estimate,
  risks: final.risks,
  operator_questions: verdict.operator_questions,
}
