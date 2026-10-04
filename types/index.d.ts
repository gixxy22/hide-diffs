export type SessionTally = { files: string[]; added: number; removed: number }
// The lines one finished call added and removed, keyed by its tool_use_id.
export type CallChanges = Record<string, { added: number; removed: number }>

declare module 'claude-code' {
  interface PluginState {
    'hide-diffs': { isHiding: boolean; tally: SessionTally; startRoot: string | null; changes: CallChanges }
  }
}
