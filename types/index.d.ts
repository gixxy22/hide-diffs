export type SessionTally = { files: string[]; added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    'hide-diffs': { isHiding: boolean; tally: SessionTally; startRoot: string | null }
  }
}
