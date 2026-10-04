import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CallChanges, SessionTally } from '../types'

type PatchHunk = { newStart?: number; lines: string[] }
type FileChangeOutput = {
  filePath: string
  structuredPatch?: PatchHunk[]
  type?: 'create' | 'update'
  content?: string
  gitDiff?: { additions: number; deletions: number }
  staged?: boolean
}
type NotebookOutput = { notebook_path: string; cell_id?: string; old_source?: string; new_source: string }
type BashEditDiff = { files: { filePath: string; hunks: PatchHunk[] }[]; moreFiles: number }
type BashOutput = { bashEditDiff?: BashEditDiff }
type Change = { added: number; removed: number }
type TextElement = ReturnType<EngineInterface['ui']['resolve']>['Text']

const DIFF_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const TRACKED_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'] as const
// Tools whose runs the transcript folds into one line (`Made 3 edits +33 -5`).
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

// The chord bound to this action in ~/.claude/keybindings.json (ctrl+q) presses the toggle button.
// A plugin can only borrow an engine action while no engine handler of it is mounted: the diff
// panel holds app:toggleDiffNoiseFilter whenever the diff has test files, so ctrl+q never reached
// the button. settings:sortByTokens is only handled inside the /usage dialog.
const TOGGLE_ACTION = 'settings:sortByTokens'
const STORE_KEY = 'isHiding'
const isHiding = atom({ plugin: 'hide-diffs', key: 'isHiding' } as const, true)
const tally = atom({ plugin: 'hide-diffs', key: 'tally' } as const, { files: [], added: 0, removed: 0 } as SessionTally)
// The project root when the session started; paths stay relative to it after `/cd` or a worktree move.
const startRoot = atom({ plugin: 'hide-diffs', key: 'startRoot' } as const, null as string | null)
// Each finished call's counts, for the compact line: a live call row need not carry its result.
const changes = atom({ plugin: 'hide-diffs', key: 'changes' } as const, {} as CallChanges)

function countChangedLines(hunks: PatchHunk[] = []): Change {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

// The lines a finished Edit or Write added and removed; undefined for one held for
// review, which leaves the file unchanged and whose diff the person needs to see.
function fileChange(output: FileChangeOutput): Change | undefined {
  if (output.staged) return undefined
  // A new file's patch can be empty: count the lines it was written with.
  if (output.type === 'create') {
    return { added: output.content ? output.content.replace(/\n$/, '').split('\n').length : 0, removed: 0 }
  }
  // An empty patch means the diff timed out or the file was too large; git's counts stand in.
  if (!output.structuredPatch?.length && output.gitDiff) {
    return { added: output.gitDiff.additions, removed: output.gitDiff.deletions }
  }
  return countChangedLines(output.structuredPatch)
}

// The new-file line number of the first added or removed line.
function firstChangedLine(hunks: PatchHunk[] = []) {
  const hunk = hunks[0]
  if (!hunk?.newStart) return undefined
  let line = hunk.newStart
  for (const text of hunk.lines) {
    if (text.startsWith('+') || text.startsWith('-')) return line
    line += 1
  }
  return undefined
}

// Lines only in one side of a cell, counted as a multiset: close enough for a summary.
function countNotebookLines(output: NotebookOutput): Change {
  const before = output.old_source ? output.old_source.split('\n') : []
  const after = output.new_source ? output.new_source.split('\n') : []
  const remaining = new Map<string, number>()
  for (const line of before) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after) {
    const left = remaining.get(line) ?? 0
    if (left > 0) remaining.set(line, left - 1)
    else added += 1
  }
  let removed = 0
  for (const left of remaining.values()) removed += left
  return { added, removed }
}

function relativePath(filePath: string, projectRoot: string) {
  const path = filePath.replace(/\\/g, '/')
  const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/'
  // Windows paths ignore case; elsewhere a folder differing only in case is another folder.
  const isWindows = /^[a-z]:\//i.test(root)
  const isInside = isWindows ? path.toLowerCase().startsWith(root.toLowerCase()) : path.startsWith(root)
  return isInside ? path.slice(root.length) : path
}

function summarize(change: Change) {
  return `(+${change.added} −${change.removed})`
}

// `(+N −N)` with the added count green and the removed count red, in the theme's colours.
function coloredSummary(Text: TextElement, change: Change) {
  return (
    <Text>
      (<Text color="success">+{change.added}</Text> <Text color="error">−{change.removed}</Text>)
    </Text>
  )
}

// What a hidden diff's summary says: the file it changed and the lines it added and removed.
// Undefined for anything drawn in full: another tool, a missing output, a review, a small diff.
type HiddenChange = { what: string; change: Change }

function describeChange(tool: string, output: unknown, root: string, isSmall: (change: Change) => boolean): HiddenChange | undefined {
  if (tool === 'Bash') {
    const changes = (output as BashOutput | undefined)?.bashEditDiff
    if (!changes) return undefined
    const fileCount = changes.files.length + changes.moreFiles
    const change = countChangedLines(changes.files.flatMap(file => file.hunks))
    if (fileCount === 0 || isSmall(change)) return undefined
    return { what: `Changed ${fileCount} file${fileCount === 1 ? '' : 's'}`, change }
  }

  if (tool === 'NotebookEdit') {
    const notebook = output as NotebookOutput | undefined
    if (!notebook?.notebook_path) return undefined
    const change = countNotebookLines(notebook)
    if (isSmall(change)) return undefined
    const cell = notebook.cell_id ? ` cell ${notebook.cell_id}` : ''
    return { what: `Changed ${relativePath(notebook.notebook_path, root)}${cell}`, change }
  }

  if (!DIFF_TOOLS.has(tool)) return undefined
  const file = output as FileChangeOutput | undefined
  if (!file?.filePath) return undefined
  const change = fileChange(file)
  if (!change || isSmall(change)) return undefined
  const verb = file.type === 'create' ? 'Created' : 'Changed'
  const line = file.type === 'create' ? undefined : firstChangedLine(file.structuredPatch)
  return { what: `${verb} ${relativePath(file.filePath, root)}${line ? `:${line}` : ''}`, change }
}

// How the engine lays out an Edit or Write row, which no API reports (as akilin/claude-plugins'
// better-tool-rows measures it): a blank line, then `● Update(path)` as wide as the line,
// up to GROUP_INDENT columns further in inside a group, a result line opening with ROW_GUTTER.
const GROUP_INDENT = 6
const ROW_GUTTER = '  ⎿  '
// Tools whose row label is `● Name(file_path)`, so the counts can be laid just past it.
const LABELED_TOOLS = new Set(['Edit', 'Write'])

// The name the engine draws an Edit or Write row under.
function rowName(tool: string, input: { old_string?: unknown }) {
  return tool === 'Write' ? 'Write' : input.old_string === '' ? 'Create' : 'Update'
}

// The columns a string takes on a terminal: 2 for wide CJK characters and pictographs.
function textWidth(text: string) {
  let width = 0
  for (const char of text) {
    const c = char.codePointAt(0) ?? 0
    if (/^[\p{Mn}\p{Me}​-‍︀-️]$/u.test(char)) continue
    const isWide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) || (c >= 0x1f300 && c <= 0x1faff)
    width += isWide ? 2 : 1
  }
  return width
}

// Relative to `root` with its own separators, as the engine draws a path it is handed.
function shortPath(path: string, root: string) {
  const dir = /[\\/]$/.test(root) ? root : `${root}/`
  const head = path.slice(0, dir.length)
  const isWindows = /^([A-Za-z]:[\\/]|\\\\)/.test(root)
  const fold = (text: string) => text.replace(/\\/g, '/').toLowerCase()
  return (isWindows ? fold(head) === fold(dir) : head === dir) ? path.slice(dir.length) : path
}

export const register: Register = (on, options) => {
  // Diffs with this many changed lines or fewer are drawn in full; 0 hides every diff.
  const smallDiffLines = Math.max(0, Number(options.smallDiffLines ?? 5))
  const isSmall = (change: Change) => change.added + change.removed <= smallDiffLines
  // Marks where a diff was hidden; empty for none.
  const icon = String(options.icon ?? '🔶').trim()
  const lead = icon ? `${icon} ` : ''
  // Puts the counts on the call's own line and drops the summary line under it.
  const compact = options.compact === true

  // Restore the last toggle from the store, so it survives restarts, and record the starting root.
  on('session.start', async ($, e, next) => {
    if ((await read($, startRoot)) === null) {
      const root = await $.session.root()
      await update($, startRoot, () => root)
    }
    const saved = await $.store.get(STORE_KEY)
    if (typeof saved === 'boolean') await update($, isHiding, () => saved)
    return next(e)
  })

  // Add each finished change to the session tally shown on the switch.
  on('tool.call', { tool: TRACKED_TOOLS }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran

    const files: string[] = []
    let change: Change = { added: 0, removed: 0 }
    if (e.tool === 'Bash') {
      const diff = (ran.result as BashOutput | undefined)?.bashEditDiff
      if (!diff) return ran
      files.push(...diff.files.map(file => file.filePath))
      change = countChangedLines(diff.files.flatMap(file => file.hunks))
    } else if (e.tool === 'NotebookEdit') {
      const output = ran.result as NotebookOutput | undefined
      if (!output?.notebook_path) return ran
      files.push(output.notebook_path)
      change = countNotebookLines(output)
    } else {
      const output = ran.result as FileChangeOutput | undefined
      const changed = output?.filePath ? fileChange(output) : undefined
      if (!output || !changed) return ran
      files.push(output.filePath)
      change = changed
    }

    await update($, tally, current => ({
      files: [...new Set([...current.files, ...files])],
      added: current.added + change.added,
      removed: current.removed + change.removed,
    }))
    await update($, changes, current => ({ ...current, [e.tool_use_id]: change }))
    return ran
  })

  // A small dim switch above the prompt; it must stay mounted for the chord to reach it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const hiding = await read($, isHiding)
    const totals = await read($, tally)
    const { Button } = $.ui.resolve(e)
    const fileCount = totals.files.length
    const tallyText = fileCount
      ? ` · ${fileCount} file${fileCount === 1 ? '' : 's'} ${summarize(totals)} this session`
      : ''

    return (
      <Button
        action={TOGGLE_ACTION}
        dimColor
        key="toggle-diffs"
        label={`${hiding ? 'Diffs hidden (ctrl+q to show)' : 'Diffs shown (ctrl+q to hide)'}${tallyText}`}
        onPress={async () => {
          const nowHiding = await update($, isHiding, value => !value)
          await $.store.set(STORE_KEY, nowHiding)
          $.ui.toast(nowHiding ? 'Diffs hidden' : 'Diffs shown')
        }}
        plain
      />
    )
  })

  // The transcript folds runs of edits into one line; while diffs are shown, unfold
  // those runs so ctrl+q visibly brings every diff back.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || !e.props.calls.some(call => FILE_TOOLS.has(call.tool))) return next(e)
    if (!(await read($, isHiding))) return next({ ...e, props: { ...e.props, isExpanded: true } })

    // Folded: lay the icon over the line's blank indent, so the engine's text stays where it is.
    const row = await next(e)
    if (!icon || e.surface !== 'terminal') return row
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        {row}
        <Box position="absolute" bottom={0} left={0}>
          <Text>{icon}</Text>
        </Box>
      </Box>
    )
  })

  // Compact: the counts ride on the call's own line (`● Write(src/a.ts)  (+12 −0)`) and
  // the result line under it is dropped, so each hidden diff takes one line.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!compact || !LABELED_TOOLS.has(e.props.tool)) return next(e)
    if (e.props.isRunning || e.props.isErrored || e.props.isInterrupted) return next(e)
    const input = e.props.input as { file_path?: unknown; old_string?: unknown } | undefined
    if (typeof input?.file_path !== 'string' || !(await read($, isHiding))) return next(e)

    // The row's own result when it carries one, else what the call recorded.
    const root = (await read($, startRoot)) ?? (await $.session.root())
    const recorded = (await read($, changes))[e.props.tool_use_id]
    const change =
      describeChange(e.props.tool, e.props.output, root, isSmall)?.change ??
      (recorded && !isSmall(recorded) ? recorded : undefined)
    if (!change) return next(e)

    // Hand the engine the path relative to the root, so the label's width is known, and
    // leave its row whole (status dot and all): the counts are laid over its last line.
    const path = shortPath(input.file_path, root)
    const row = await next({ ...e, props: { ...e.props, input: { ...input, file_path: path } } })
    const { Box, Text } = $.ui.resolve(e)
    const counts = (
      <Text dimColor>
        {lead}
        {coloredSummary(Text, change)}
      </Text>
    )
    const labelWidth = textWidth(`● ${rowName(e.props.tool, input)}(${path})`)
    const countsWidth = textWidth(`${lead}${summarize(change)}`)
    const columns = e.viewport?.columns ?? 80

    // A label too long for the line wraps; the counts go on a line of their own beneath it.
    if (labelWidth + 2 + countsWidth > columns - GROUP_INDENT) {
      return (
        <Box flexDirection="column">
          {row}
          <Box>
            <Text dimColor>{ROW_GUTTER}</Text>
            {counts}
          </Box>
        </Box>
      )
    }
    return (
      <Box>
        {row}
        <Box position="absolute" bottom={0} left={labelWidth + 2}>
          {counts}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.isErrored || !(await read($, isHiding))) return next(e)

    const root = (await read($, startRoot)) ?? (await $.session.root())
    const hidden = describeChange(e.props.tool, e.props.output, root, isSmall)
    if (!hidden) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    // Bash: draw its own output, minus the per-file diff of what the command changed.
    if (e.props.tool === 'Bash') {
      const { bashEditDiff: _hidden, ...outputWithoutDiff } = e.props.output as BashOutput
      const drawn = await next({ ...e, props: { ...e.props, output: outputWithoutDiff } })
      return (
        <Box flexDirection="column">
          {drawn}
          <Text dimColor>
            {lead}
            {hidden.what} {coloredSummary(Text, hidden.change)}
          </Text>
        </Box>
      )
    }

    // Compact: an Edit or Write row already carries the counts.
    if (compact && LABELED_TOOLS.has(e.props.tool)) return <Box />

    return (
      <Text dimColor>
        {lead}
        {hidden.what} {coloredSummary(Text, hidden.change)}
      </Text>
    )
  })
}
