export type Post = { id: number; at: number; from: string; to: string[]; text: string }
export type MemberStatus = 'active' | 'waiting' | 'killed'
export type Member = {
  name: string
  agentId: string
  status: MemberStatus
  isIsolated: boolean
  model?: string
  // Set by swarm_set_model: every later request of this worker goes to it.
  switchedModel?: string
}
export type SwarmInfo = { isOn: boolean; task: string; lastActivity: number; isNudged: boolean }
export type PaneView = 'board' | 'members' | 'graph'
// Board tab: search text, member filter ('' = everyone), follow (-1) or the last post id held in view,
// the last post id read (the "New" divider sits after it), the post opened in full (0 = none).
// isFilterOpen shows the member chips the filter picks from.
export type BoardUi = { search: string; filter: string; follow: number; seen: number; open: number; isFilterOpen: boolean }
export type MembersUi = { search: string; isRetiredOpen: boolean }
// Graph tab: how many posts the replay shows (-1 = live), whether it plays forward on its own,
// and whether members with no arrows so far are left out.
export type GraphUi = { at: number; isPlaying: boolean; isActiveOnly: boolean }

declare module 'claude-code' {
  interface PluginState {
    swarm: {
      posts: Shaped<Post[]>
      members: Shaped<Member[]>
      info: Shaped<SwarmInfo>
      view: Shaped<PaneView>
      board: Shaped<BoardUi>
      membersUi: Shaped<MembersUi>
      graph: Shaped<GraphUi>
      // How many posts there were when the status row was dismissed; a newer post brings it back.
      bandHiddenAt: Shaped<number>
    }
  }
}
