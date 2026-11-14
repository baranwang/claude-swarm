import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { BoardUi, GraphUi, Member, MembersUi, PaneView, Post, SwarmInfo } from '../types'
import { avatarSvg, barSvg, edges, graphSvg, hueOf, scrubSvg } from './graph'
import type { GraphNode } from './graph'

export { edges } from './graph'

const P = 'swarm'
const PANE = 'swarm-board'
const COORD = 'coordinator'
const QUIET_MS = 3 * 60_000
const TICK_MS = 2_000
const tool = <N extends string>(name: N) => `mcp__swarm__${name}` as const

const posts = atom({ plugin: 'swarm', key: 'posts' } as const, [] as Post[], { shape: 'posts-1' })
const members = atom({ plugin: 'swarm', key: 'members' } as const, [] as Member[], { shape: 'members-1' })
const IDLE: SwarmInfo = { isOn: false, task: '', lastActivity: 0, isNudged: false }
const info = atom({ plugin: 'swarm', key: 'info' } as const, IDLE, { shape: 'info-1' })
const view = atom({ plugin: 'swarm', key: 'view' } as const, 'board' as PaneView, { shape: 'view-3' })
const BOARD: BoardUi = { search: '', filter: '', follow: -1, seen: 0, open: 0, isFilterOpen: false }
const board = atom({ plugin: 'swarm', key: 'board' } as const, BOARD, { shape: 'board-2' })
const membersUi = atom({ plugin: 'swarm', key: 'membersUi' } as const, { search: '', isRetiredOpen: false } as MembersUi, { shape: 'membersUi-1' })
const GRAPH: GraphUi = { at: -1, isPlaying: false, isActiveOnly: false }
const graph = atom({ plugin: 'swarm', key: 'graph' } as const, GRAPH, { shape: 'graph-2' })
const bandHiddenAt = atom({ plugin: 'swarm', key: 'bandHiddenAt' } as const, -1, { shape: 'bandHiddenAt-1' })

const WORKER_PROMPT = `You are a worker in a swarm. Your name and brief are in your first message.
- Do only what your brief says you own; never touch what it says not to.
- Your only channel to others is ${tool('board_post')}: mention recipients with @name, @group (@fix reaches fix-1, fix-2, ...) or @all. Use ${tool('board_read')} to catch up on what others said. Never use SendMessage.
- Post only to ask for something or to deliver what was asked. Never post acknowledgements, thanks or "noted".
- @name is a doorbell, never a CC: every mention wakes that member and costs it a turn. Mention only the peer who acts next.
- Posts carry numbers (#4). Point to an earlier post by its number instead of copying or summarising it.
- When your turn ends, your final message reaches @coordinator automatically: that is your only line to the coordinator (a post to @coordinator is only recorded on the board). End with a short status: done or blocked (on what, or the question you need answered), files changed, how you verified.
- If you run in your own worktree, commit your work on its branch before you finish.
- After your turn you sleep at no cost; a post that mentions you wakes you as a new message.`

const coordinatorPrompt = (task: string) => `Swarm mode is on and you are the coordinator. You do not do the technical work yourself: you split it, add workers, judge their output and report to the user.

Task: ${task}

How to run it:
1. Split the task into pieces with clear ownership. For each, call ${tool('swarm_spawn')} with a short name (parser, docs; fix-1..fix-4 for a pool) and a brief stating what the worker owns, what it must not touch, and what "done" means.
2. Set isolated: true for workers that edit or build at the same time as others: each gets its own git worktree, commits on its own branch, and you merge the branches before removing them.
3. Add a verifier (e.g. @verify) for every two to four workers: it reads diffs, runs tests and posts problems to the worker that wrote the code.
4. Name the swarm with ${tool('swarm_title')} as soon as you know what the work is. Talk only on the board with ${tool('board_post')} (@name, @group, @all). @name is a doorbell, never a CC: mention only who acts next. Refer to earlier posts by number (#4) instead of copying a report into a post for someone else. Each worker's end-of-turn report arrives to you as a message; their posts to @coordinator are only recorded on the board (read it with ${tool('board_read')} when you need the context). Between them, end your turn and wait; do not poll.
5. Pass model on a spawn for a cheaper or stronger worker when it fits (e.g. haiku for mechanical work). To move a worker to another model later, keeping its conversation, call ${tool('swarm_set_model')}.
6. Remove a worker that is done or stuck with ${tool('swarm_kill')}; removal is permanent, so add a new one if needed.
7. When the verifier signs off, call ${tool('swarm_end')} and report the outcome to the user.`

// The monitor's nudges for the coordinator. shortcut: kept in module memory, so a mod reload drops an undelivered one.
let inbox: string[] = []

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const mentions = (text: string) => [...new Set([...text.matchAll(/@([A-Za-z0-9_-]+)/g)].map(m => m[1] ?? ""))]
// One line of at most n characters.
const clip = (t: string, n: number) => {
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, Math.max(1, n - 1)) + '…' : one
}
const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)
// Mentions stand out in a post opened in full.
const emph = (t: string) => t.replace(/(^|\s)@([A-Za-z0-9_-]+)/g, '$1**@$2**')
// A worker's report opens with the mentions it was addressed by; the row shows what it says.
const gist = (t: string) => t.replace(/^(\s*@[A-Za-z0-9_-]+)+\s*/, '')
// The opening of a post for the feed: whole lines up to a budget, with an unclosed code span closed.
export function preview(text: string, budget = 260): { text: string; isCut: boolean } {
  const lines = text.trim().split('\n')
  let out = ''
  for (const l of lines) {
    if (out && (out.length + l.length > budget || out.split('\n').length >= 4)) return { text: closeTicks(out) + ' …', isCut: true }
    if (!out && l.length > budget) return { text: closeTicks(l.slice(0, l.lastIndexOf(' ', budget) > 40 ? l.lastIndexOf(' ', budget) : budget)) + ' …', isCut: true }
    out += (out ? '\n' : '') + l
  }
  return { text: out, isCut: false }
}
// A link no browser could open, reserved TLD, that the board answers itself.
const moreHref = (id: number) => `https://swarm.invalid/post/${id}`
const closeTicks = (t: string) => ((t.match(/`/g)?.length ?? 0) % 2 ? t + '`' : t)

// Colors as raw hex: the desktop draws few theme keys, and these read on light and dark alike.
const INK = '#8b8b8b'
const ACCENT = '#d97757'
const HOVER = '#8b8b8b1f'
const STATE = { active: ['working', '#2fa66a'], waiting: ['waiting', '#c9a227'], killed: ['killed', INK] } as const

const line = (p: Post) => `#${p.id} @${p.from} → ${p.to.map(t => '@' + t).join(' ') || '(no one)'}: ${p.text}`

// Two workers trading posts with nobody else in between: past this many, posts between them stop
// waking each other, so an acknowledgement loop cannot run on its own.
export const LOOP_LIMIT = 8
export function isLooping(list: Post[], a: string, b: string) {
  let n = 0
  for (let i = list.length - 1; i >= 0 && (list[i]!.from === a || list[i]!.from === b); i--) n++
  return n >= LOOP_LIMIT
}

// Who the mentioned handles reach: a name, a group prefix (fix → fix-1..), all, coordinator.
export function resolve(handles: string[], live: Member[], from: string) {
  const names = new Set<string>()
  const unknown: string[] = []
  for (const h of handles) {
    if (h === 'all') {
      names.add(COORD)
      live.forEach(m => names.add(m.name))
    } else if (h === COORD) names.add(COORD)
    else {
      const hit = live.filter(m => m.name === h || m.name.startsWith(h + '-'))
      if (hit.length) hit.forEach(m => names.add(m.name))
      else unknown.push(h)
    }
  }
  names.delete(from)
  return { to: [...names], unknown }
}

const nameOf = async ($: EngineInterface, agentId?: string) =>
  agentId ? (await read($, members)).find(m => m.agentId === agentId)?.name : COORD

const setStatus = ($: EngineInterface, name: string, status: Member['status']) =>
  update($, members, list =>
    list.map(m => (m.name === name && m.status !== 'killed' ? { ...m, status } : m)),
  )

// Records a post and delivers it to workers by message (resuming a sleeping one).
// `only` records the post as addressed to those names whatever its text mentions (a brief, a report).
const post = async ($: EngineInterface, from: string, text: string, deliver = true, only?: string[]) => {
  const live = (await read($, members)).filter(m => m.status !== 'killed')
  const { to, unknown } = only ? { to: only, unknown: [] as string[] } : resolve(mentions(text), live, from)
  let id = 0
  const at = Date.now()
  await update($, posts, list => {
    id = (list.at(-1)?.id ?? 0) + 1
    return [...list, { id, at, from, to, text }].slice(-500)
  })
  const p: Post = { id, at, from, to, text }
  await update($, info, i => ({ ...i, lastActivity: p.at, isNudged: false }))
  const isHeld = to.includes(COORD)
  if (!deliver) return { to, unknown, isHeld }
  const reached: string[] = []
  for (const name of to) {
    // Only workers post to the coordinator, and every worker's turn end hands its report back to it:
    // delivering the post as well would reach the coordinator twice. The board keeps it.
    if (name === COORD) continue
    const m = live.find(x => x.name === name)!
    if (isLooping(await read($, posts), from, name)) {
      unknown.push(`${name} (held: you and @${name} have traded ${LOOP_LIMIT} posts in a row; end your turn and let @${COORD} decide)`)
      continue
    }
    // Active before the send: a send that wakes a sleeping worker resolves only after its turn,
    // whose turn.complete has already set it back to waiting.
    await setStatus($, name, 'active')
    const sent = await $.session.send({
      to: { agentId: m.agentId },
      text: `[swarm board #${id}] @${from}: ${text}\n(Reply with ${tool('board_post')} only if this asks you for something; do not acknowledge.)`,
    })
    if (sent.isDelivered) reached.push(name)
    else {
      await setStatus($, name, m.status)
      unknown.push(`${name} (${sent.reason})`)
    }
  }
  return { to: reached, unknown, isHeld }
}

const ok = (text: string) => ({ result: text })
const coordOnly = (agentId?: string) =>
  agentId ? { deny: 'Only the swarm coordinator may do this; post to @coordinator instead.' } : undefined

const kill = async ($: EngineInterface, m: Member) => {
  try {
    await $.tool.call({ tool: 'TaskStop', task_id: m.agentId })
  } catch {
    // already finished: nothing runs to stop
  }
  await setStatus($, m.name, 'killed')
}

// A new swarm starts on a clean board: posts, roster and every view's place in them.
const resetSwarm = async ($: EngineInterface) => {
  await update($, posts, () => [])
  await update($, members, () => [])
  await update($, board, () => BOARD)
  await update($, graph, () => GRAPH)
  await update($, bandHiddenAt, () => -1)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'swarm',
      description: 'Run a task as a swarm: /swarm <task> | /swarm board | /swarm stop',
    })
    const workerSpec = { description: 'A swarm worker (spawned by the swarm mod only)', prompt: WORKER_PROMPT, background: true as const }
    await $.agent.register({ name: 'worker', ...workerSpec })
    await $.agent.register({ name: 'worker-isolated', ...workerSpec, isolation: 'worktree' })

    const tools = [
      {
        name: 'board_post',
        description:
          'Post to the swarm board. Mention recipients in the text with @name, @group (prefix of name-N) or @all; only mentioned members are woken.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      {
        name: 'board_read',
        description: 'Read the swarm board: the roster with each member\'s state, then posts. since = the highest post number you have seen (only newer posts); last = how many, default 30.',
        inputSchema: {
          type: 'object',
          properties: {
            since: { type: 'number', description: 'Only posts after this number' },
            last: { type: 'number', description: 'How many posts, default 30' },
          },
        },
      },
      {
        name: 'swarm_spawn',
        description:
          'Coordinator only: add a named worker with a clean context. brief = what it owns, what it must not touch, what done means.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short handle, letters/digits/-, e.g. parser or fix-1' },
            brief: { type: 'string' },
            isolated: { type: 'boolean', description: 'Give it its own git worktree' },
            model: { type: 'string', description: 'Optional model alias or id, e.g. haiku' },
          },
          required: ['name', 'brief'],
        },
      },
      {
        name: 'swarm_kill',
        description: 'Coordinator only: permanently remove a worker (stops it if running).',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
      {
        name: 'swarm_set_model',
        description:
          'Coordinator only: move a worker to another model (alias like haiku/sonnet/opus or a full id). It keeps its conversation; its next request uses the new model.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, model: { type: 'string' } },
          required: ['name', 'model'],
        },
      },
      {
        name: 'swarm_title',
        description: 'Coordinator only: name the swarm for the board and the status row, e.g. "the parser rewrite".',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
      {
        name: 'swarm_end',
        description: 'Coordinator only: end the swarm, stopping every worker.',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
    for (const t of tools) await $.tool.register({ ...t, isDeferred: false })

    // Delivers coordinator posts in one batch, and plays the monitor: nudges once when the team goes quiet.
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const g = await read($, graph)
        if (g.isPlaying) {
          const total = (await read($, posts)).length
          await update($, graph, x => (x.at < 0 || x.at >= total ? { ...x, at: -1, isPlaying: false } : { ...x, at: x.at + 1 }))
        }
        const i = await read($, info)
        if (i.isOn && !i.isNudged && Date.now() - i.lastActivity > QUIET_MS) {
          const live = (await read($, members)).filter(m => m.status !== 'killed')
          if (live.length && live.every(m => m.status === 'waiting')) {
            await update($, info, x => ({ ...x, isNudged: true }))
            inbox.push(`@monitor: the board has been quiet for ${QUIET_MS / 60_000} min and every worker is asleep. Check what is left, wake someone, or call ${tool('swarm_end')}.`)
          }
        }
        if (!inbox.length) return
        const batch = inbox
        inbox = []
        await $.prompt.submit({ text: `[swarm board]\n${batch.join('\n\n')}` })
      })()
    })

    return next(e)
  })


  on('command.run', { command: 'swarm' }, async ($, e) => {
    const args = e.args.trim()
    await $.ui.open({ id: PANE, title: 'Swarm' })
    if (!args || args === 'board') return { text: 'Swarm board opened.' }
    if (args === 'stop') {
      for (const m of (await read($, members)).filter(x => x.status !== 'killed')) await kill($, m)
      await update($, info, i => ({ ...i, isOn: false }))
      return { text: 'Swarm stopped.' }
    }
    await resetSwarm($)
    await update($, info, () => ({ isOn: true, task: args, lastActivity: Date.now(), isNudged: false }))
    // A submit from inside the command would wait on the turn this hook holds: send it once the command is done.
    $.clock.after(0, () => void $.prompt.submit({ text: coordinatorPrompt(args) }).catch(() => {}))
    return { text: 'Swarm started.' }
  })

  on('tool.call', { tool: tool('board_post') }, async ($, e) => {
    const text = str(e.text)
    if (!text) return { deny: 'text is empty' }
    const from = (await nameOf($, e.agentId)) ?? 'unknown'
    const { to, unknown, isHeld } = await post($, from, text)
    return ok(
      (to.length || !isHeld ? `Posted to ${to.map(t => '@' + t).join(' ') || 'no one (mention someone to wake them)'}.` : 'Recorded on the board.') +
        (isHeld ? ` @${COORD} reads it with your end-of-turn report; to get an answer, end your turn with the question.` : '') +
        (unknown.length ? ` Not reached: ${unknown.join(', ')}.` : ''),
    )
  })

  on('tool.call', { tool: tool('board_read') }, async ($, e) => {
    const n = typeof e.last === 'number' && e.last > 0 ? e.last : 30
    const since = typeof e.since === 'number' ? e.since : 0
    const list = (await read($, posts)).filter(p => p.id > since).slice(-n)
    const word = { active: 'working', waiting: 'waiting', killed: 'killed' } as const
    const roster = (await read($, members)).map(m => `@${m.name} (${word[m.status]}, ${m.switchedModel ?? m.model ?? 'inherited'})`).join(', ')
    return ok(`Members: @${COORD}, ${roster || 'none'}\n\n${list.map(line).join('\n\n') || 'No posts yet.'}`)
  })

  on('tool.call', { tool: tool('swarm_spawn') }, async ($, e) => {
    const denied = coordOnly(e.agentId)
    if (denied) return denied
    const name = str(e.name)
    const brief = str(e.brief)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name) || name === COORD || name === 'all')
      return { deny: `Invalid name "${name}": use letters, digits, - or _, not "all" or "${COORD}".` }
    if (!brief) return { deny: 'brief is empty' }
    // The first spawn after a swarm ended starts a new one: the old board and roster go.
    if (!(await read($, info)).isOn) {
      await resetSwarm($)
      await update($, info, () => ({ ...IDLE, lastActivity: Date.now() }))
    }
    const list = await read($, members)
    if (list.some(m => m.name === name && m.status !== 'killed')) return { deny: `@${name} already exists.` }
    const isIsolated = e.isolated === true
    const model = str(e.model) || undefined
    const spawned = await $.agent.spawn({
      subagentType: `${P}:${isIsolated ? 'worker-isolated' : 'worker'}`,
      description: `swarm @${name}`,
      prompt: `You are @${name}. The coordinator is @${COORD}.\n\nYour brief:\n${brief}`,
      model,
    })
    if ('deny' in spawned && spawned.deny) return { deny: `Spawn refused: ${spawned.deny}` }
    if (!spawned.agentId) return { deny: 'Spawn started no agent.' }
    const agentId = spawned.agentId
    await update($, members, l => [
      ...l.filter(m => m.name !== name),
      { name, agentId, status: 'active' as const, isIsolated, model: spawned.model },
    ])
    await update($, info, i => ({ ...i, isOn: true }))
    await post($, COORD, `@${name} ${brief}`, false, [name])
    // The pane opens with the swarm however it started, not only from /swarm.
    const { isPlaced } = await $.ui.open({ id: PANE, title: 'Swarm' })
    return ok(`Spawned @${name} on ${spawned.model}${isIsolated ? ' in its own worktree' : ''}.${isPlaced ? '' : ' (No surface shows the Swarm pane right now.)'}`)
  })

  on('tool.call', { tool: tool('swarm_kill') }, async ($, e) => {
    const denied = coordOnly(e.agentId)
    if (denied) return denied
    const m = (await read($, members)).find(x => x.name === str(e.name) && x.status !== 'killed')
    if (!m) return { deny: `No live worker @${str(e.name)}.` }
    await kill($, m)
    return ok(`@${m.name} removed.`)
  })

  on('tool.call', { tool: tool('swarm_title') }, async ($, e) => {
    const denied = coordOnly(e.agentId)
    if (denied) return denied
    const title = str(e.title).slice(0, 80)
    if (!title) return { deny: 'title is empty' }
    await update($, info, i => ({ ...i, task: title }))
    return ok(`Swarm titled "${title}".`)
  })

  on('tool.call', { tool: tool('swarm_end') }, async ($, e) => {
    const denied = coordOnly(e.agentId)
    if (denied) return denied
    for (const m of (await read($, members)).filter(x => x.status !== 'killed')) await kill($, m)
    await update($, info, i => ({ ...i, isOn: false }))
    inbox = []
    return ok('Swarm ended; every worker stopped.')
  })

  on('tool.call', { tool: tool('swarm_set_model') }, async ($, e) => {
    const denied = coordOnly(e.agentId)
    if (denied) return denied
    const name = str(e.name)
    const model = str(e.model)
    if (!model) return { deny: 'model is empty' }
    const m = (await read($, members)).find(x => x.name === name && x.status !== 'killed')
    if (!m) return { deny: `No live worker @${name}.` }
    await update($, members, l => l.map(x => (x.name === name ? { ...x, switchedModel: model } : x)))
    return ok(
      `@${name} moves to ${model} from its next request` +
        (m.status === 'active' ? ' (it is mid-turn now, so the switch lands on its next step).' : '.'),
    )
  })

  // A switched worker's requests go to its new model; its conversation is untouched.
  on('turn.step', async function* ($, e, next) {
    const m = e.agentId ? (await read($, members)).find(x => x.agentId === e.agentId) : undefined
    return yield* next(m?.switchedModel ? { ...e, model: m.switchedModel } : e)
  })

  // Keeps the board the only channel: workers may not message each other privately.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    if (e.agentId && (await nameOf($, e.agentId))) return { deny: `Swarm workers talk only on the board: use ${tool('board_post')}.` }
    return next(e)
  })

  // A worker's turn ended: it sleeps. The engine already hands its final message back to the
  // coordinator, so the board only records it.
  on('turn.complete', async ($, e, next) => {
    const name = e.agentId ? await nameOf($, e.agentId) : undefined
    const m = name ? (await read($, members)).find(x => x.name === name) : undefined
    if (m && m.status !== 'killed') {
      await setStatus($, m.name, 'waiting')
      const answer = e.answer.trim()
      if (answer && !e.isAborted) await post($, m.name, `@${COORD} ${answer}`, false, [COORD])
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Input, Markdown } = els
    // The terminal has no Svg: avatars become a colored dot there, the graph a list.
    const isTerminal = e.surface === 'terminal'
    const Svg = !isTerminal && 'Svg' in els ? els.Svg : undefined
    const i = await read($, info)
    const roster = await read($, members)
    const all = await read($, posts)
    const tab = await read($, view)
    const width = Math.max(24, e.props.bodyColumns - 6)
    const room = Math.max(4, Math.floor(((e.viewport?.rows ?? 30) - 8) / 3))
    const hex = (name: string) => hueOf(name)[1]
    const live = roster.filter(m => m.status !== 'killed')
    const avatar = (name: string, dim = false) =>
      Svg ? <Svg source={avatarSvg(name)} alt={name} width={28} height={28} /> : <Text color={dim ? INK : hex(name)}>●</Text>

    if (!i.isOn && all.length === 0)
      return (
        <Box flexDirection="column" gap="sm" paddingY="md">
          <Text bold>No swarm in this conversation</Text>
          <Text dimColor>{'Start one with /swarm <task>: its board, members and graph show up here.'}</Text>
        </Box>
      )

    const go = async (id: PaneView) => {
      // Leaving the board marks what it showed as read.
      if ((await read($, view)) === 'board' && id !== 'board') {
        const last = (await read($, posts)).at(-1)?.id ?? 0
        await update($, board, b => ({ ...b, seen: last }))
      }
      await update($, view, () => id)
    }
    // The desktop draws a Button's contents in its own style, dropping color and weight, and pads it.
    // So a selected choice is plain Text (padded like a Button), and a color sits beside the Button.
    const choice = (key: string, label: string, isOn: boolean, onPress: () => unknown, dot?: string, count?: number) => (
      <Box key={`c-${key}`} flexDirection="row" alignItems="center">
        {dot ? <Text color={dot}>●</Text> : null}
        {isOn ? (
          <Box paddingX="sm">
            <Text>
              <Text bold>{label}</Text>
              {count ? <Text dimColor>{` ${count}`}</Text> : null}
            </Text>
          </Box>
        ) : (
          <Button key={key} plain onPress={onPress}>
            {count ? `${label} ${count}` : label}
          </Button>
        )}
      </Box>
    )
    const tabs: [PaneView, string, number][] = [
      ['board', 'Board', all.length],
      ['members', 'Members', live.length + 1],
      ['graph', 'Graph', 0],
    ]
    const header = (
      <Box flexDirection="column" gap="md">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold size="title">{clip(i.task || 'Swarm', width - 8)}</Text>
          {i.isOn ? <Text color="#2fa66a">● Live</Text> : <Text dimColor>Ended</Text>}
        </Box>
        <Box flexDirection="row" gap="md" alignItems="flex-end">
          {tabs.map(([id, label, n]) => {
            const isOn = tab === id
            return (
              <Box key={`tabbox-${id}`} flexDirection="column" gap="xs" alignItems="center">
                {choice(`tab-${id}`, label, isOn, () => go(id), undefined, n)}
                {Svg ? (
                  <Svg source={barSvg((label.length + (n ? String(n).length + 1 : 0)) * 9 + 8, isOn ? ACCENT : '#00000000')} alt={isOn ? 'selected' : 'tab'} />
                ) : null}
              </Box>
            )
          })}
        </Box>
      </Box>
    )
    // One feed row, as agy draws a post: avatar on the left, then who → whom with the number and time on the right, then the text.
    const feedRow = (key: string, who: string, head: RenderChildren, meta: string, body: RenderChildren, opts: { dim?: boolean; isLit?: boolean } = {}) => (
      <Box
        key={key}
        flexDirection="row"
        alignItems="flex-start"
        gap="sm"
        paddingX="sm"
        paddingY="sm"
        backgroundColor={opts.isLit ? HOVER : undefined}
        hover={{ backgroundColor: HOVER }}
      >
        {avatar(who, opts.dim)}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} gap="xs">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
            {head}
            <Text dimColor mono>{meta}</Text>
          </Box>
          {body}
        </Box>
      </Box>
    )
    const who = (from: string, to: string[], dim = false) => (
      <Text>
        <Text bold dimColor={dim}>{`@${from}`}</Text>
        <Text dimColor>{to.length ? `  →  ${to.map(t => '@' + t).join(' ')}` : ''}</Text>
      </Text>
    )

    if (tab === 'members') {
      const mu = await read($, membersUi)
      const q = mu.search.toLowerCase()
      const shown = roster.filter(m => !q || `${m.name} ${m.model ?? ''} ${m.switchedModel ?? ''}`.toLowerCase().includes(q))
      const latest = (name: string) => [...all].reverse().find(p => p.from === name)
      const briefOf = (name: string) => all.find(p => p.from === COORD && p.to.includes(name))
      const memberRow = (m: Member) => {
        const last = latest(m.name)
        const brief = briefOf(m.name)
        const gone = m.status === 'killed'
        const model = m.switchedModel ? `${m.model ?? '?'} → ${m.switchedModel}` : (m.model ?? 'inherited')
        const doing = last ? gist(last.text) : brief ? `Brief: ${gist(brief.text)}` : ''
        return feedRow(
          `m-${m.name}`,
          m.name,
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Text>
              <Text bold dimColor={gone}>{`@${m.name}`}</Text>
              <Text color={STATE[m.status][1]}>{`   ● ${STATE[m.status][0]}`}</Text>
              {m.isIsolated ? <Text dimColor>{'   ⎇ worktree'}</Text> : null}
            </Text>
          </Box>,
          `${model}${last ? ` · #${last.id}` : ''}`,
          doing ? <Text dimColor>{clip(doing, width - 12)}</Text> : null,
          { dim: gone },
        )
      }
      const section = (title: string, list: Member[]) =>
        list.length ? (
          <Box key={`g-${title}`} flexDirection="column" gap="xs">
            <Box paddingX="sm">
              <Text dimColor size="caption">{`${title} · ${list.length}`}</Text>
            </Box>
            {list.map(memberRow)}
          </Box>
        ) : null
      const retired = shown.filter(m => m.status === 'killed')
      const coordLast = latest(COORD)
      return (
        <Box flexDirection="column" gap="md">
          {header}
          <Input
            key="member-search"
            placeholder="Search members"
            value={mu.search}
            onInput={v => update($, membersUi, x => ({ ...x, search: v }))}
            onSubmit={v => update($, membersUi, x => ({ ...x, search: v }))}
          />
          {feedRow(
            'm-coordinator',
            COORD,
            <Text bold>{`@${COORD}`}</Text>,
            coordLast ? `#${coordLast.id}` : '',
            <Text dimColor>This conversation</Text>,
          )}
          {section('Active', shown.filter(m => m.status === 'active'))}
          {section('Standing by', shown.filter(m => m.status === 'waiting'))}
          {retired.length ? (
            <Box flexDirection="column" gap="xs">
              <Button key="retired" plain onPress={() => update($, membersUi, x => ({ ...x, isRetiredOpen: !x.isRetiredOpen }))}>
                {`${mu.isRetiredOpen ? '▾' : '▸'} Retired · ${retired.length}`}
              </Button>
              {mu.isRetiredOpen ? retired.map(memberRow) : null}
            </Box>
          ) : null}
          {roster.length === 0 ? <Text dimColor>No workers yet.</Text> : null}
        </Box>
      )
    }

    if (tab === 'graph') {
      const g = await read($, graph)
      const upTo = g.at < 0 || g.at > all.length ? all.length : g.at
      const list = edges(all, upTo)
      const cur = all[upTo - 1]
      const prev = all[upTo - 2]
      const step = async (n: number) => {
        const total = (await read($, posts)).length
        await update($, graph, x => (n >= total ? { ...x, at: -1, isPlaying: false } : { ...x, at: Math.max(1, n), isPlaying: false }))
      }
      const play = async () => {
        const total = (await read($, posts)).length
        await update($, graph, x => (x.isPlaying ? { ...x, isPlaying: false } : { ...x, at: x.at < 0 || x.at >= total ? 1 : x.at, isPlaying: true }))
      }
      const drawn = new Set(list.flatMap(x => [x.from, x.to]))
      // Hide inactive: only members with an arrow so far, as agy's toggle of the same name.
      const nodes: GraphNode[] = [
        { name: COORD, status: 'coordinator' },
        ...roster
          .filter(m => (g.isActiveOnly ? drawn.has(m.name) : m.status !== 'killed' || drawn.has(m.name)))
          .map(m => ({ name: m.name, status: m.status })),
      ]
      const isLive = g.at < 0
      const gap = cur && prev ? Math.round((cur.at - prev.at) / 1000) : 0
      const hhmmss = (at: number) => new Date(at).toTimeString().slice(0, 8)
      return (
        <Box flexDirection="column" gap="md">
          {header}
          <Box flexDirection="column" gap="sm">
            <Box flexDirection="row" alignItems="center" gap="sm">
              <Button key="g-first" plain onPress={() => step(1)}>⏮</Button>
              <Button key="g-prev" plain onPress={() => step(upTo - 1)}>◀</Button>
              <Button key="g-play" onPress={play}>{g.isPlaying ? '⏸ Pause' : '⏵ Play'}</Button>
              <Button key="g-next" plain onPress={() => step(upTo + 1)}>▶</Button>
              <Box flexGrow={1} flexShrink={1} alignItems="center">
                {Svg ? <Svg source={scrubSvg(upTo, all.length)} alt={`Post ${upTo} of ${all.length}`} width={360} height={14} /> : null}
              </Box>
              {choice('g-live', 'Live', isLive, () => update($, graph, x => ({ ...x, at: -1, isPlaying: false })), isLive ? '#2fa66a' : INK)}
            </Box>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Text>
                <Text bold>{`${upTo}`}</Text>
                <Text dimColor>{` of ${all.length}${cur ? ` · #${cur.id} at ${hhmmss(cur.at)}${prev ? ` (+${gap}s)` : ''}` : ''}`}</Text>
              </Text>
              {choice('g-hide', g.isActiveOnly ? 'Show all' : 'Hide inactive', false, () => update($, graph, x => ({ ...x, isActiveOnly: !x.isActiveOnly })))}
            </Box>
          </Box>
          {Svg ? (
            <Box flexDirection="column" alignItems="center">
              <Svg source={graphSvg(nodes, list)} alt={`Swarm graph: ${nodes.length} members, ${list.length} @mention arrows up to post ${upTo}`} width={640} height={400} />
            </Box>
          ) : list.length === 0 ? (
            <Text dimColor>No @mentions yet.</Text>
          ) : (
            <Box flexDirection="column">
              {list.slice(0, room * 3).map(x => (
                <Text key={`${x.from}>${x.to}`}>
                  <Text color={hex(x.from)} bold={x.isLatest}>{x.from}</Text>
                  <Text dimColor>{' ──▶ '}</Text>
                  <Text color={hex(x.to)} bold={x.isLatest}>{x.to}</Text>
                  <Text dimColor>{`  ×${x.count}`}</Text>
                </Text>
              ))}
            </Box>
          )}
          <Text dimColor size="footnote">{'──▶  @mention, width = posts     ─▶  the post shown, in orange     ○ waiting   ● working'}</Text>
          {cur
            ? feedRow(
                'g-cur',
                cur.from,
                who(cur.from, cur.to),
                `#${cur.id} · ${hhmm(cur.at)}`,
                <Markdown key="g-cur-md" text={preview(emph(gist(cur.text)), 900).text} />,
                { isLit: true },
              )
            : null}
        </Box>
      )
    }

    const ui = await read($, board)
    const q = ui.search.toLowerCase()
    const shown = all.filter(
      p =>
        (!ui.filter || p.from === ui.filter || p.to.includes(ui.filter)) &&
        (!q || `${p.from} ${p.to.join(' ')} ${p.text}`.toLowerCase().includes(q)),
    )
    const list = (ui.follow < 0 ? shown : shown.filter(p => p.id <= ui.follow)).slice(-room)
    const firstNew = list.find(p => p.id > ui.seen)?.id
    const unread = all.filter(p => p.id > ui.seen).length
    const newer = ui.follow < 0 ? 0 : all.filter(p => p.id > ui.follow).length
    const isFollowing = ui.follow < 0
    const follow = async () => {
      const last = (await read($, posts)).at(-1)?.id ?? 0
      await update($, board, b => ({ ...b, follow: b.follow < 0 ? last : -1 }))
    }
    const markRead = async () => {
      const last = (await read($, posts)).at(-1)?.id ?? 0
      await update($, board, b => ({ ...b, seen: last }))
    }
    const pick = (name: string) => update($, board, b => ({ ...b, filter: name }))
    return (
      <Box flexDirection="column" gap="md">
        {header}
        <Box flexDirection="column" gap="sm">
          <Box flexDirection="row" gap="sm" alignItems="center">
            <Box flexGrow={1} flexShrink={1} width="100%">
              <Input
                key="search"
                placeholder="Search"
                value={ui.search}
                onInput={v => update($, board, b => ({ ...b, search: v }))}
                onSubmit={v => update($, board, b => ({ ...b, search: v }))}
              />
            </Box>
            <Button key="filter" plain onPress={() => update($, board, b => ({ ...b, isFilterOpen: !b.isFilterOpen }))}>
              {ui.filter ? `Filter: @${ui.filter}` : 'Filter'}
            </Button>
            {choice('follow', 'Follow', false, follow, isFollowing ? '#2fa66a' : INK)}
          </Box>
          {ui.isFilterOpen ? (
            <Box flexDirection="row" gap="sm" flexWrap="wrap" alignItems="center">
              {choice('chip-all', 'Everyone', !ui.filter, () => pick(''))}
              {[COORD, ...roster.map(m => m.name)].map(n => choice(`chip-${n}`, n, ui.filter === n, () => pick(n), hex(n)))}
            </Box>
          ) : null}
        </Box>
        {list.length === 0 ? <Text dimColor>{all.length ? 'No posts match.' : 'No posts yet.'}</Text> : null}
        <Box flexDirection="column">
          {list.map(p => {
            const isOpen = ui.open === p.id
            // The recipients head the row, so the text drops the mentions it opens with.
            const body = isOpen ? { text: emph(p.text), isCut: false } : preview(emph(gist(p.text)))
            const toggle = () => update($, board, b => ({ ...b, open: b.open === p.id ? 0 : p.id }))
            return (
              <Box key={`post-${p.id}`} flexDirection="column">
                {p.id === firstNew ? (
                  <Box flexDirection="row" gap="sm" alignItems="center" paddingX="sm">
                    <Text color={ACCENT} bold size="caption">{`New · ${unread}`}</Text>
                    <Button key="mark-read" plain onPress={markRead}>
                      Mark read
                    </Button>
                  </Box>
                ) : null}
                {feedRow(
                  `row-${p.id}`,
                  p.from,
                  who(p.from, p.to),
                  `#${p.id} · ${hhmm(p.at)}`,
                  // Show more / less is a link at the end of the text, so it lines up with it; the mod answers the click.
                  <Markdown
                    key={`md-${p.id}`}
                    text={body.isCut ? `${body.text} [Show\u00a0more](${moreHref(p.id)})` : isOpen && body.text !== preview(emph(gist(p.text))).text ? `${body.text}\n\n[Show\u00a0less](${moreHref(p.id)})` : body.text}
                    pressableLinks={[moreHref(p.id)]}
                    onLinkPress={() => void toggle()}
                  />,
                  { isLit: isOpen },
                )}
              </Box>
            )
          })}
        </Box>
        {newer ? (
          <Button key="jump" plain onPress={follow}>
            {`↓ ${newer} newer post${newer > 1 ? 's' : ''}`}
          </Button>
        ) : null}
      </Box>
    )
  })

  // The status row above the prompt, as agy's CLI shows one: the latest post, the post count, who is working.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const i = await read($, info)
    const all = await read($, posts)
    const hiddenAt = await read($, bandHiddenAt)
    const last = all.at(-1)
    if (e.props.hasSurvey || !i.isOn || !last || all.length <= hiddenAt) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const working = (await read($, members)).filter(m => m.status === 'active').length
    const room = Math.max(16, e.props.bodyColumns - 60)
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Text color="#2fa66a">●</Text>
        <Text bold>{clip(i.task || 'Swarm', 24)}</Text>
        <Text dimColor>·</Text>
        <Text color={hueOf(last.from)[1]} bold>{`@${last.from}`}</Text>
        <Text dimColor>{clip(gist(last.text), room)}</Text>
        <Text dimColor size="footnote">{`#${last.id} · ${all.length} posts${working ? ` · ${working} working` : ''}`}</Text>
        <Button
          key="band-board"
          plain
          onPress={async () => {
            await update($, view, () => 'board')
            await $.ui.open({ id: PANE, title: 'Swarm' })
          }}
        >
          <Text color={ACCENT}>Open board</Text>
        </Button>
        <Button
          key="band-dismiss"
          plain
          role="dismiss"
          onPress={async () => {
            const n = (await read($, posts)).length
            await update($, bandHiddenAt, () => n)
          }}
        >
          <Text dimColor>✕</Text>
        </Button>
      </Box>
    )
  })
}
