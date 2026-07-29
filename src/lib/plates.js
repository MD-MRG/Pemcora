// Brand-plate swatches. Text and mark contrast are paired with each background
// so any choice stays legible without hand-tuning.
export const PLATES = {
  brass: {
    key: 'brass',
    name: 'Brass',
    hex: '#C8A24A',
    bg: '#c8a24a',
    fg: '#14293f',
    mark: 'rgba(20,41,63,.18)',
    edge: 'rgba(0,0,0,.16)',
    note: 'The anchor. Warm and confident against the navy — best for dark or single-colour marks.',
  },
  bone: {
    key: 'bone',
    name: 'Bone',
    hex: '#E6DCC6',
    bg: '#e6dcc6',
    fg: '#1b3a5c',
    mark: 'rgba(27,58,92,.15)',
    edge: 'rgba(0,0,0,.13)',
    note: 'Brass with the saturation pulled out — the quiet option when a logo is busy or multi-coloured.',
  },
  navy: {
    key: 'navy',
    name: 'Deep Navy',
    hex: '#12293F',
    bg: '#12293f',
    fg: '#f0e4c8',
    mark: 'rgba(200,162,74,.24)',
    edge: 'rgba(255,255,255,.14)',
    note: 'A shade below the sidebar, so the plate still reads as its own block. Gold and white marks sing on it.',
  },
  espresso: {
    key: 'espresso',
    name: 'Espresso',
    hex: '#2A2119',
    bg: '#2a2119',
    fg: '#e8d5a6',
    mark: 'rgba(200,162,74,.26)',
    edge: 'rgba(255,255,255,.13)',
    note: 'Warm near-black rather than cold — a true black would grey the brass out.',
  },
}

export const PLATE_LIST = Object.values(PLATES)
export const DEFAULT_PLATE = 'brass'

// Push a swatch onto the document so every plate instance follows.
export function applyPlate(key) {
  const p = PLATES[key] ?? PLATES[DEFAULT_PLATE]
  const s = document.documentElement.style
  s.setProperty('--plate-bg', p.bg)
  s.setProperty('--plate-fg', p.fg)
  s.setProperty('--plate-mark', p.mark)
  s.setProperty('--plate-edge', p.edge)
  return p
}
