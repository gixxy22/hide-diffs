import type { RenderElement } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const ABOVE_PROMPT = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

function editOutput(filePath: string, added: number) {
  return {
    filePath,
    oldString: 'old',
    newString: 'new',
    originalFile: 'old',
    userModified: false,
    replaceAll: false,
    structuredPatch: [
      {
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 2 + added,
        lines: [' context', ' context', '-old', ...Array.from({ length: added }, (_, i) => `+new ${i}`)],
      },
    ],
  }
}

for (const surface of SURFACES) {
  test(`${surface}: a large edit collapses to its path, line and counts`, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'full diff') as RenderElement)

    const ui = await $.ui.mount({
      plugin: 'hide-diffs',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 't1', tool: 'Edit', isErrored: false, output: editOutput('C:\\repo\\src\\a.ts', 6) },
    })

    expect(await ui.find({ text: '🔶 Changed src/a.ts:12 (+6 −1)' })).toBeDefined()

    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.find(t => t.text === '+6')?.props.color).toBe('success')
    expect(texts.find(t => t.text === '−1')?.props.color).toBe('error')
  })

  test(`${surface}: a small edit is drawn in full`, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'full diff') as RenderElement)

    const ui = await $.ui.mount({
      plugin: 'hide-diffs',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 't2', tool: 'Edit', isErrored: false, output: editOutput('C:/repo/a.ts', 1) },
    })

    expect(await ui.find({ text: 'full diff' })).toBeDefined()
  })

  test(`${surface}: smallDiffLines 0 hides even a one-line edit`, { options: { smallDiffLines: 0 } }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'full diff') as RenderElement)

    const ui = await $.ui.mount({
      plugin: 'hide-diffs',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 't3', tool: 'Edit', isErrored: false, output: editOutput('C:/repo/a.ts', 1) },
    })

    expect(await ui.find({ text: 'full diff' })).toBeUndefined()
  })

  test(`${surface}: the switch tallies edits and its press is saved`, async ($, on) => {
    on('tool.call', { tool: 'Edit' }, () => ({ result: editOutput('C:/repo/a.ts', 6) }))
    const store = new Map<string, unknown>()
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => {
      store.set(e.key, e.value)
      return { value: undefined }
    })

    await $.tool.call({ tool: 'Edit', file_path: 'C:/repo/a.ts', old_string: 'old', new_string: 'new' })
    await $.tool.call({ tool: 'Edit', file_path: 'C:/repo/a.ts', old_string: 'old', new_string: 'new' })

    const ui = await $.ui.mount({ plugin: 'hide-diffs', surface, component: 'AbovePrompt', props: ABOVE_PROMPT })
    const label = String((await ui.find({ key: 'toggle-diffs' }))?.props.label)
    expect(label).toContain('Diffs hidden')
    expect(label).toContain('1 file (+12 −2) this session')

    await ui.press({ key: 'toggle-diffs' })
    expect(String((await ui.find({ key: 'toggle-diffs' }))?.props.label)).toContain('Diffs shown')
    expect(store.get('isHiding')).toBe(false)
  })
}

for (const surface of SURFACES) {
  const mountResult = ($: Engine, tool: string, output: unknown) =>
    $.ui.mount({ plugin: 'hide-diffs', surface, component: 'ToolResult', props: { tool_use_id: 'r', tool, isErrored: false, output } })

  test(`${surface}: a new file counts the lines it was written with`, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'full diff') as RenderElement)

    const content = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const ui = await mountResult($, 'Write', { type: 'create', filePath: 'C:/repo/new.ts', content, structuredPatch: [], originalFile: null })

    expect(await ui.find({ text: '🔶 Created new.ts (+20 −0)' })).toBeDefined()
  })

  test(`${surface}: an edit held for review keeps its diff`, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'full diff') as RenderElement)

    const ui = await mountResult($, 'Edit', { ...editOutput('C:/repo/a.ts', 20), staged: true })

    expect(await ui.find({ text: 'full diff' })).toBeDefined()
  })

  test(`${surface}: an empty patch falls back to git's counts`, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'full diff') as RenderElement)

    const ui = await mountResult($, 'Write', {
      type: 'update',
      filePath: 'C:/repo/big.ts',
      content: 'x',
      structuredPatch: [],
      originalFile: null,
      gitDiff: { filename: 'big.ts', status: 'modified', additions: 40, deletions: 2, changes: 42, patch: '' },
    })

    expect(await ui.find({ text: '🔶 Changed big.ts (+40 −2)' })).toBeDefined()
  })

  test(`${surface}: paths stay relative to the project root, case-sensitive off Windows`, async ($, on) => {
    on('session.root', () => ({ value: '/home/me/repo' }))
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'full diff') as RenderElement)

    const inside = await mountResult($, 'Edit', editOutput('/home/me/repo/src/a.ts', 6))
    expect(await inside.find({ text: '🔶 Changed src/a.ts:12 (+6 −1)' })).toBeDefined()

    const other = await mountResult($, 'Edit', editOutput('/home/me/Repo/src/a.ts', 6))
    expect(await other.find({ text: '🔶 Changed /home/me/Repo/src/a.ts:12 (+6 −1)' })).toBeDefined()
  })
}

for (const surface of SURFACES) {
  test(`${surface}: showing diffs unfolds a folded run of edits`, async ($, on) => {
    const store = new Map<string, unknown>()
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => {
      store.set(e.key, e.value)
      return { value: undefined }
    })
    on('ui.render', { component: 'ToolGroup' }, ($, e) =>
      h($.ui.resolve(e).Text, {}, e.props.isExpanded ? 'expanded' : 'folded') as RenderElement,
    )

    const call = { tool: 'Edit', input: {}, isRunning: false, isErrored: false, isInterrupted: false }
    const group = await $.ui.mount({
      plugin: 'hide-diffs',
      surface,
      component: 'ToolGroup',
      props: { calls: [call, call], isActive: false, isExpanded: false },
    })
    expect(await group.find({ text: 'folded' })).toBeDefined()

    const band = await $.ui.mount({ plugin: 'hide-diffs', surface, component: 'AbovePrompt', props: ABOVE_PROMPT })
    await band.press({ key: 'toggle-diffs' })
    expect(await group.find({ text: 'expanded' })).toBeDefined()

    await band.press({ key: 'toggle-diffs' })
    expect(await group.find({ text: 'folded' })).toBeDefined()
  })

  test(`${surface}: a run of reads stays folded with diffs shown`, async ($, on) => {
    on('store.set', () => ({ value: undefined }))
    on('ui.render', { component: 'ToolGroup' }, ($, e) =>
      h($.ui.resolve(e).Text, {}, e.props.isExpanded ? 'expanded' : 'folded') as RenderElement,
    )
    const band = await $.ui.mount({ plugin: 'hide-diffs', surface, component: 'AbovePrompt', props: ABOVE_PROMPT })
    await band.press({ key: 'toggle-diffs' })
    expect(String((await band.find({ key: 'toggle-diffs' }))?.props.label)).toContain('Diffs shown')

    const call = { tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false }
    const group = await $.ui.mount({
      plugin: 'hide-diffs',
      surface,
      component: 'ToolGroup',
      props: { calls: [call], isActive: false, isExpanded: false },
    })
    expect(await group.find({ text: 'folded' })).toBeDefined()
  })
}

for (const surface of SURFACES) {
  test(`${surface}: an empty icon setting leaves the summary bare`, { options: { icon: '' } }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'full diff') as RenderElement)

    const ui = await $.ui.mount({
      plugin: 'hide-diffs',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'i', tool: 'Edit', isErrored: false, output: editOutput('C:/repo/a.ts', 6) },
    })
    expect((await ui.findAll({ type: 'Text' })).some(t => t.text.startsWith('Changed a.ts:12'))).toBe(true)
    expect((await ui.findAll({ type: 'Text' })).some(t => t.text.includes('🔶'))).toBe(false)
  })
}

test('terminal: a folded run of edits gets the icon, a run of reads does not', async ($, on) => {
  on('ui.render', { component: 'ToolGroup' }, ($, e) => h($.ui.resolve(e).Text, {}, '  Made 2 edits +3 -1') as RenderElement)
  const call = (tool: string) => ({ tool, input: {}, isRunning: false, isErrored: false, isInterrupted: false })

  const edits = await $.ui.mount({
    plugin: 'hide-diffs',
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: [call('Edit'), call('Edit')], isActive: false, isExpanded: false },
  })
  expect(await edits.find({ text: '🔶' })).toBeDefined()
  expect(await edits.find({ text: '  Made 2 edits +3 -1' })).toBeDefined()

  const reads = await $.ui.mount({
    plugin: 'hide-diffs',
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: [call('Read')], isActive: false, isExpanded: false },
  })
  expect(await reads.find({ text: '🔶' })).toBeUndefined()
})

for (const surface of SURFACES) {
  const toolUse = (output: unknown) => ({
    tool_use_id: 'c',
    tool: 'Write',
    input: { file_path: 'C:/repo/src/a.ts', content: '' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output,
  })
  const created = { type: 'create', filePath: 'C:/repo/src/a.ts', content: 'x\n'.repeat(12), structuredPatch: [], originalFile: null }

  test(`${surface}: compact mode puts the counts on the call's line and drops the result line`, { options: { compact: true } }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolUse' }, ($, e) => h($.ui.resolve(e).Text, {}, '● Write(src/a.ts)') as RenderElement)
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'full diff') as RenderElement)

    const row = await $.ui.mount({ plugin: 'hide-diffs', surface, component: 'ToolUse', props: toolUse(created) })
    expect(await row.find({ text: '● Write(src/a.ts)' })).toBeDefined()
    expect((await row.findAll({ type: 'Text' })).some(t => t.text.includes('🔶 (+12 −0)'))).toBe(true)
    // Laid over the row's last line, 2 columns past `● Write(src/a.ts)`, leaving the row whole.
    const overlay = (await row.findAll({ type: 'Box' })).find(b => b.props.position === 'absolute')
    expect(overlay?.props.left).toBe('● Write(src/a.ts)'.length + 2)

    const result = await $.ui.mount({
      plugin: 'hide-diffs',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'c', tool: 'Write', isErrored: false, output: created },
    })
    expect((await result.findAll({ type: 'Text' })).length).toBe(0)
  })

  test(`${surface}: without compact mode the call's line is left alone`, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolUse' }, ($, e) => h($.ui.resolve(e).Text, {}, '● Write(src/a.ts)') as RenderElement)

    const row = await $.ui.mount({ plugin: 'hide-diffs', surface, component: 'ToolUse', props: toolUse(created) })
    expect((await row.findAll({ type: 'Text' })).some(t => t.text.includes('(+12'))).toBe(false)
  })
}

for (const surface of SURFACES) {
  test(`${surface}: compact mode counts a live row that carries no result`, { options: { compact: true, smallDiffLines: 0 } }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('tool.call', { tool: 'Edit' }, () => ({ result: editOutput('C:/repo/README.md', 2) }))
    on('ui.render', { component: 'ToolUse' }, ($, e) => h($.ui.resolve(e).Text, {}, 'Update(README.md)') as RenderElement)

    await $.tool.call({ tool: 'Edit', tool_use_id: 'live', file_path: 'C:/repo/README.md', old_string: 'old', new_string: 'new' })

    const row = await $.ui.mount({
      plugin: 'hide-diffs',
      surface,
      component: 'ToolUse',
      props: { tool_use_id: 'live', tool: 'Edit', input: { file_path: 'C:/repo/README.md', old_string: 'old' }, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect((await row.findAll({ type: 'Text' })).some(t => t.text.includes('🔶 (+2 −1)'))).toBe(true)
  })
}

for (const surface of SURFACES) {
  test(`${surface}: compact mode keeps a shell command's summary line`, { options: { compact: true, smallDiffLines: 0 } }, async ($, on) => {
    on('session.root', () => ({ value: 'C:/repo' }))
    on('ui.render', { component: 'ToolResult' }, ($, e) => h($.ui.resolve(e).Text, {}, 'output') as RenderElement)

    const output = { stdout: '', stderr: '', bashEditDiff: { files: [{ filePath: 'C:/repo/a.ts', hunks: [{ lines: ['+x', '-y'] }] }], moreFiles: 0 } }
    const ui = await $.ui.mount({ plugin: 'hide-diffs', surface, component: 'ToolResult', props: { tool_use_id: 'b', tool: 'Bash', isErrored: false, output } })
    expect((await ui.findAll({ type: 'Text' })).some(t => t.text.includes('Changed 1 file'))).toBe(true)
  })
}
