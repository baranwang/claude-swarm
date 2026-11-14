import { expect, test } from 'claude-code/testing'

import { avatarSvg, graphSvg } from '../hooks/graph'
import { edges, isLooping, LOOP_LIMIT, preview, resolve } from '../hooks/register'

const PANE = {
  plugin: 'swarm',
  component: 'Pane',
  requestId: 'swarm-board',
  props: { title: 'Swarm', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('mentions resolve names, groups, all; the poster is left out', () => {
  const live = ['parser', 'fix-1', 'fix-2'].map(name => ({ name, agentId: name, status: 'waiting' as const, isIsolated: false }))
  expect(resolve(['fix', 'nobody'], live, 'parser')).toEqual({ to: ['fix-1', 'fix-2'], unknown: ['nobody'] })
  expect(resolve(['all'], live, 'fix-1').to).toEqual(['coordinator', 'parser', 'fix-2'])
})

test('edges count arrows and mark the latest post, up to a replay point', () => {
  const posts = [
    { id: 1, at: 0, from: 'coordinator', to: ['a', 'b'], text: '' },
    { id: 2, at: 0, from: 'a', to: ['coordinator'], text: '' },
    { id: 3, at: 0, from: 'coordinator', to: ['a'], text: '' },
  ]
  expect(edges(posts)).toEqual([
    { from: 'coordinator', to: 'a', count: 2, isLatest: true },
    { from: 'coordinator', to: 'b', count: 1, isLatest: false },
    { from: 'a', to: 'coordinator', count: 1, isLatest: false },
  ])
  expect(edges(posts, 2).find(x => x.isLatest)).toEqual({ from: 'a', to: 'coordinator', count: 1, isLatest: true })
})

test('the graph draws every member as a node and each arrow with its count, the latest in the accent', () => {
  const svg = graphSvg(
    [{ name: 'coordinator', status: 'coordinator' }, { name: 'parser', status: 'active' }, { name: 'old', status: 'killed' }],
    [{ from: 'coordinator', to: 'parser', count: 3, isLatest: true }, { from: 'parser', to: 'coordinator', count: 1, isLatest: false }],
  )
  expect(svg.startsWith('<svg')).toBe(true)
  for (const name of ['>coordinator<', '>parser<', '>old<']) expect(svg).toContain(name)
  expect(svg).toContain('>3</text>')
  expect(svg).toContain('url(#hot)')
  expect(svg).toContain('stroke-dasharray')
  // An arrow to a node not drawn is left out rather than drawn to nowhere.
  expect(graphSvg([{ name: 'coordinator', status: 'coordinator' }], [{ from: 'coordinator', to: 'x', count: 1, isLatest: true }])).not.toContain('Q')
})

test('a long post previews as whole lines with an open code span closed', () => {
  expect(preview('short')).toEqual({ text: 'short', isCut: false })
  const long = preview(`run \`python3 -m py_compile ${'x'.repeat(300)}`)
  expect(long.isCut).toBe(true)
  expect((long.text.match(/`/g) ?? []).length % 2).toBe(0)
  expect(preview('a\nb\nc\nd\ne').text).toBe('a\nb\nc\nd …')
  expect(avatarSvg('parser')).toContain('>PA<')
  expect(avatarSvg('coordinator')).not.toContain('<text')
})

test('a pair trading posts alone past the limit is a loop; anyone else in between breaks it', () => {
  const p = (from: string) => ({ id: 0, at: 0, from, to: [], text: '' })
  const pair = Array.from({ length: LOOP_LIMIT }, (_, i) => p(i % 2 ? 'a' : 'b'))
  expect(isLooping(pair, 'a', 'b')).toBe(true)
  expect(isLooping(pair.slice(1), 'a', 'b')).toBe(false)
  expect(isLooping([...pair.slice(0, 4), p('coordinator'), ...pair.slice(4)], 'a', 'b')).toBe(false)
})

test('guards hold and a post lands on the board and the pane', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('agent.register', () => ({ value: { agent: 'swarm:worker' } }))
  on('tool.register', () => ({ value: {} }))
  on('clock.every', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The engine alone sets a spawn's agentId; a stub starts none.
  on('agent.spawn', () => ({ model: 'm' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect((await $.tool.call({ tool: 'mcp__swarm__swarm_spawn', name: 'x', brief: 'y', agentId: 'a1' })).deny).toContain('Only the swarm coordinator')
  expect((await $.tool.call({ tool: 'mcp__swarm__swarm_spawn', name: 'all', brief: 'y' })).deny).toContain('Invalid name')
  expect((await $.tool.call({ tool: 'mcp__swarm__swarm_spawn', name: 'p', brief: 'y' })).deny).toBe('Spawn started no agent.')

  const posted = await $.tool.call({ tool: 'mcp__swarm__board_post', text: 'plan: @parser owns src/parse.ts' })
  expect(String(posted.result)).toContain('Not reached: parser')

  const board = await $.tool.call({ tool: 'mcp__swarm__board_read' })
  expect(String(board.result)).toContain('@coordinator → (no one): plan: @parser owns src/parse.ts')

  await $.tool.call({ tool: 'mcp__swarm__board_post', text: 'second note: tests run on CI' })
  await $.tool.call({ tool: 'mcp__swarm__board_post', text: `long note ${'word '.repeat(80)}END` })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Markdown', text: /owns src\/parse/ }))).toBeDefined()

  // Board: both posts are unread under the New divider; mark read clears it.
  expect((await ui.find({ type: 'Text', text: /New · 3/ }))).toBeDefined()
  await ui.press({ plugin: 'swarm', key: 'mark-read' })
  expect(await ui.find({ type: 'Text', text: /New ·/ })).toBeUndefined()

  // A long post ends in a Show more link the board answers itself; opened, it ends in Show less.
  const long = await ui.find({ type: 'Markdown', text: /Show\u00a0more\]\(https:\/\/swarm\.invalid\/post\/3\)$/ })
  expect(long).toBeDefined()
  await ui.press({ plugin: 'swarm', key: 'md-3', link: { href: 'https://swarm.invalid/post/3' } } as never)
  expect((await ui.find({ type: 'Markdown', text: /END\n\n\[Show\u00a0less\]/ }))).toBeDefined()

  // Search narrows the feed.
  await ui.input({ plugin: 'swarm', key: 'search', text: 'ci' })
  expect(await ui.find({ type: 'Markdown', text: /owns src\/parse/ })).toBeUndefined()
  await ui.input({ plugin: 'swarm', key: 'search', text: '' })
  // A short post shows whole, mentions bold, with no Show more.
  expect((await ui.find({ type: 'Markdown' }))?.props).toMatchObject({ text: 'plan: **@parser** owns src/parse.ts' })

  // Filter to one member (only names on the roster are offered): the coordinator wrote both.
  await ui.press({ plugin: 'swarm', key: 'filter' })
  await ui.press({ plugin: 'swarm', key: 'chip-coordinator' })
  expect((await ui.find({ type: 'Markdown', text: /tests run on CI/ })), 'filtered').toBeDefined()
  await ui.input({ plugin: 'swarm', key: 'search', text: 'nothing like this' })
  expect((await ui.find({ type: 'Text', text: /No posts match/ })), 'no match').toBeDefined()
  await ui.input({ plugin: 'swarm', key: 'search', text: '' })
  await ui.press({ plugin: 'swarm', key: 'chip-all' })

  // Graph tab: drawn as a picture on the desktop.
  await ui.press({ plugin: 'swarm', key: 'tab-graph' })
  expect((await ui.find({ type: 'Svg' }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^ of 3 · #3 at / }))).toBeDefined()
  await ui.press({ plugin: 'swarm', key: 'g-first' })
  expect((await ui.find({ type: 'Text', text: /^ of 3 · #1 at / }))).toBeDefined()
  await ui.press({ plugin: 'swarm', key: 'g-hide' })
  // The toggle stays drawn (now Show all) and turns back.
  await ui.press({ plugin: 'swarm', key: 'g-hide' })

  // Members tab: the coordinator first, with its latest post.
  await ui.press({ plugin: 'swarm', key: 'tab-members' })
  expect((await ui.find({ type: 'Text', text: /This conversation/ }))).toBeDefined()
  await ui.unmount()

  // The terminal has no Svg: the graph falls back to text.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.press({ plugin: 'swarm', key: 'tab-graph' })
  expect((await term.find({ type: 'Text', text: /No @mentions yet/ }))).toBeDefined()
  // Every tab draws a valid tree on the terminal too (no Svg, no card borders).
  await term.press({ plugin: 'swarm', key: 'tab-board' })
  expect((await term.find({ type: 'Markdown', text: /tests run on CI/ }))).toBeDefined()
  await term.press({ plugin: 'swarm', key: 'tab-members' })
  expect((await term.find({ type: 'Text', text: /This conversation/ }))).toBeDefined()
  await term.unmount()

  // A worker's post to the coordinator is recorded, not delivered: its turn end hands the report over.
  const held = await $.tool.call({ tool: 'mcp__swarm__board_post', text: '@coordinator done', agentId: 'w1' })
  expect(String(held.result)).toBe('Recorded on the board. @coordinator reads it with your end-of-turn report; to get an answer, end your turn with the question.')
  expect(String((await $.tool.call({ tool: 'mcp__swarm__board_read', last: 1 })).result)).toContain('@unknown → @coordinator: @coordinator done')

  // swarm_set_model refuses a worker that does not exist.
  expect((await $.tool.call({ tool: 'mcp__swarm__swarm_set_model', name: 'ghost', model: 'haiku' })).deny).toContain('No live worker')
})

test('the status row shows the latest post of a live swarm until dismissed', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('agent.register', () => ({ value: { agent: 'swarm:worker' } }))
  on('tool.register', () => ({ value: {} }))
  on('clock.every', () => ({ value: {} }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('clock.after', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Dismissed, the row goes to what is beneath: here a stand-in for the engine.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.command.run({ command: 'swarm', args: 'Build the parser' })
  await $.tool.call({ tool: 'mcp__swarm__board_post', text: 'kickoff for @all' })

  const band = await $.ui.mount({
    plugin: 'swarm',
    component: 'AbovePrompt',
    surface: 'desktop',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 120 },
  } as never)
  expect((await band.find({ type: 'Text', text: /Build the parser/ }))).toBeDefined()
  expect((await band.find({ type: 'Text', text: /kickoff for @all/ }))).toBeDefined()
  await band.press({ plugin: 'swarm', key: 'band-dismiss' })
  expect(await band.find({ type: 'Text', text: /Build the parser/ })).toBeUndefined()
  await band.unmount()
})
