export type SessionTally = { files: string[]; added: number; removed: number }
// The lines one finished call added and removed, keyed by its tool_use_id.
export type CallChanges = Record<string, { added: number; removed: number }>
// What a folded shell command's line says of its result (`16 lines`, `Exit code 1`).
export type CommandOutcome = { text: string; isError: boolean }
// Each finished shell call's outcome, keyed by its tool_use_id.
export type CommandOutcomes = Record<string, CommandOutcome>

declare module 'claude-code' {
  interface PluginState {
    'hide-diffs': {
      isHiding: boolean
      tally: SessionTally
      startRoot: string | null
      changes: CallChanges
      isFoldingCommands: boolean
      outcomes: CommandOutcomes
    }
  }
}
