// The pane's flow picker, drawn on the surface itself: the flow shown as a card, and a click (or Enter)
// opens the list of the others under it, the running ones first. A pick posts { show: name } to register.tsx.

import type { ClientModule } from 'claude-code'

export type PickerItem = { name: string; description: string; glyph: string; color: string; when: string }
export type PickerProps = { current: string | null; items: PickerItem[] }
type State = { open: boolean; cursor: number }

const CLAY = '#D97757'
/** Each card takes two rows (name, then description), so a row of the region tells which card it is. */
const ROWS = 2

const Picker: ClientModule<PickerProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? { open: false, cursor: 0 }
  const shown = props.items.find(i => i.name === props.current) ?? props.items[0]
  const others = props.items.filter(i => i !== shown)
  const pick = (item: PickerItem | undefined): void => {
    surface.setState({ open: false, cursor: 0 })
    if (item && item !== shown) surface.post({ show: item.name })
  }
  // The card at the top toggles the list; a card under it is picked.
  surface.onPointer(e => {
    if (e.type !== 'down' || e.button !== 'left') return
    const at = Math.floor(e.y / ROWS)
    if (at === 0) surface.setState({ open: !state.open, cursor: 0 })
    else if (state.open) pick(others[at - 1])
  })
  surface.onKey(e => {
    if (!state.open) {
      if (e.key === 'return' || e.key === ' ' || e.key === 'down') surface.setState({ open: true, cursor: 0 })
      return
    }
    if (e.key === 'down') surface.setState({ ...state, cursor: Math.min(others.length - 1, state.cursor + 1) })
    else if (e.key === 'up') surface.setState({ ...state, cursor: Math.max(0, state.cursor - 1) })
    else if (e.key === 'return') pick(others[state.cursor])
  })
  if (!shown) return <Box />

  const card = (item: PickerItem, key: string, isShown: boolean, isCursor: boolean) => (
    <Box key={key} flexDirection="row" height={ROWS} paddingX={1} backgroundColor={isCursor ? 'subtle' : undefined} hover={{ backgroundColor: 'subtle' }}>
      <Text color={isShown ? CLAY : undefined}>{isShown ? '▌' : ' '}</Text>
      <Box flexDirection="column" flexGrow={1} marginLeft={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color={item.color}>{`${item.glyph} `}</Text>
            <Text bold>{item.name}</Text>
          </Text>
          <Text dimColor>{isShown && others.length ? `${item.when}  ${state.open ? '▴' : '▾'}` : item.when}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">{item.description || ' '}</Text>
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" width="100%">
      {card(shown, `shown:${shown.name}`, true, false)}
      {state.open && others.map((item, k) => card(item, `item:${item.name}`, false, k === state.cursor))}
    </Box>
  )
}

export default Picker
