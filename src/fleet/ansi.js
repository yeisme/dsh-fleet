/**
 * Lightweight SGR ANSI parser for `/plugin/fleet/screen` output.
 * Parses SGR (`ESC[...m`) into styled spans and safely strips non-SGR CSI / OSC sequences.
 * Zero external dependencies; output is plain objects safe for React rendering.
 */

const STANDARD_COLORS = [
  'var(--dsw-ansi-black, #1c1c1e)',
  'var(--dsw-ansi-red, #ff453a)',
  'var(--dsw-ansi-green, #30d158)',
  'var(--dsw-ansi-yellow, #ffd60a)',
  'var(--dsw-ansi-blue, #0a84ff)',
  'var(--dsw-ansi-magenta, #bf5af2)',
  'var(--dsw-ansi-cyan, #64d2ff)',
  'var(--dsw-ansi-white, #e5e5ea)',
]

const BRIGHT_COLORS = [
  'var(--dsw-ansi-bright-black, #636366)',
  'var(--dsw-ansi-bright-red, #ff6961)',
  'var(--dsw-ansi-bright-green, #4cd964)',
  'var(--dsw-ansi-bright-yellow, #ffe620)',
  'var(--dsw-ansi-bright-blue, #409cff)',
  'var(--dsw-ansi-bright-magenta, #da8fff)',
  'var(--dsw-ansi-bright-cyan, #70d7ff)',
  'var(--dsw-ansi-bright-white, #ffffff)',
]

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

function color256(index) {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null
  if (index < 8) return STANDARD_COLORS[index]
  if (index < 16) return BRIGHT_COLORS[index - 8]
  if (index < 232) {
    const n = index - 16
    const r = CUBE_LEVELS[Math.floor(n / 36)]
    const g = CUBE_LEVELS[Math.floor((n % 36) / 6)]
    const b = CUBE_LEVELS[n % 6]
    return `rgb(${r}, ${g}, ${b})`
  }
  const gray = 8 + (index - 232) * 10
  return `rgb(${gray}, ${gray}, ${gray})`
}

function clampByte(n) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(255, Math.round(n)))
}

function emptyState() {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    fg: null,
    bg: null,
  }
}

function cloneState(s) {
  return {
    bold: s.bold,
    dim: s.dim,
    italic: s.italic,
    underline: s.underline,
    inverse: s.inverse,
    fg: s.fg,
    bg: s.bg,
  }
}

function applySgr(state, rawParams) {
  const parts = rawParams === '' ? [0] : rawParams.split(';').map((p) => (p === '' ? 0 : Number.parseInt(p, 10)))
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!Number.isFinite(code)) continue
    if (code === 0) {
      Object.assign(state, emptyState())
    } else if (code === 1) {
      state.bold = true
    } else if (code === 2) {
      state.dim = true
    } else if (code === 3) {
      state.italic = true
    } else if (code === 4) {
      state.underline = true
    } else if (code === 7) {
      state.inverse = true
    } else if (code === 22) {
      state.bold = false
      state.dim = false
    } else if (code === 23) {
      state.italic = false
    } else if (code === 24) {
      state.underline = false
    } else if (code === 27) {
      state.inverse = false
    } else if (code >= 30 && code <= 37) {
      state.fg = STANDARD_COLORS[code - 30]
    } else if (code === 39) {
      state.fg = null
    } else if (code >= 40 && code <= 47) {
      state.bg = STANDARD_COLORS[code - 40]
    } else if (code === 49) {
      state.bg = null
    } else if (code >= 90 && code <= 97) {
      state.fg = BRIGHT_COLORS[code - 90]
    } else if (code >= 100 && code <= 107) {
      state.bg = BRIGHT_COLORS[code - 100]
    } else if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg'
      const mode = parts[i + 1]
      if (mode === 5 && i + 2 < parts.length) {
        state[target] = color256(parts[i + 2])
        i += 2
      } else if (mode === 2 && i + 4 < parts.length) {
        const r = clampByte(parts[i + 2])
        const g = clampByte(parts[i + 3])
        const b = clampByte(parts[i + 4])
        state[target] = `rgb(${r}, ${g}, ${b})`
        i += 4
      }
    }
  }
}

// Matches:
// 1. CSI sequences: ESC [ <params> <intermediates> <final>
// 2. OSC sequences: ESC ] ... (BEL or ST)
// 3. Other 2-byte ESC sequences: ESC [@-Z\-_]
const ANSI_TOKEN_RE = /\u001b\[([0-9;:<=>?]*)([ -/]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

/**
 * Parse ANSI text into lines of `{ text, style }` spans.
 * Non-SGR CSI sequences and OSC sequences are stripped without affecting SGR state.
 *
 * @param {string} input
 * @returns {Array<Array<{ text: string, style: ReturnType<typeof emptyState> }>>}
 */
export function parseAnsi(input) {
  const source = typeof input === 'string' ? input.replace(/\r\n/g, '\n') : ''
  const lines = [[]]
  const state = emptyState()

  const pushText = (chunk) => {
    if (!chunk) return
    const parts = chunk.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([])
      const segment = parts[i]
      if (segment.length > 0) {
        lines[lines.length - 1].push({ text: segment, style: cloneState(state) })
      }
    }
  }

  let lastIndex = 0
  ANSI_TOKEN_RE.lastIndex = 0
  let match
  while ((match = ANSI_TOKEN_RE.exec(source)) !== null) {
    if (match.index > lastIndex) {
      pushText(source.slice(lastIndex, match.index))
    }
    const params = match[1]
    const intermediates = match[2]
    const finalByte = match[3]
    // Only apply pure SGR sequences (no private prefix chars or intermediate bytes, final === 'm')
    if (finalByte === 'm' && intermediates === '' && /^[0-9;]*$/.test(params)) {
      applySgr(state, params)
    }
    lastIndex = ANSI_TOKEN_RE.lastIndex
  }
  if (lastIndex < source.length) {
    pushText(source.slice(lastIndex))
  }
  return lines
}

/**
 * Strip all ANSI escape sequences (SGR, non-SGR CSI, OSC, ESC) to plain text.
 *
 * @param {string} input
 * @returns {string}
 */
export function stripAnsi(input) {
  if (typeof input !== 'string') return ''
  return input.replace(/\r\n/g, '\n').replace(ANSI_TOKEN_RE, '')
}

/**
 * Convert a parsed span style object into a React inline style object (or undefined if plain).
 */
export function spanToReactStyle(style) {
  if (!style) return undefined
  const out = {}
  let hasAny = false
  if (style.bold) { out.fontWeight = 600; hasAny = true }
  if (style.dim) { out.opacity = 0.62; hasAny = true }
  if (style.italic) { out.fontStyle = 'italic'; hasAny = true }
  if (style.underline) { out.textDecoration = 'underline'; hasAny = true }
  if (style.inverse) {
    out.color = style.bg ?? 'var(--dsw-alias-bg, #141416)'
    out.backgroundColor = style.fg ?? 'var(--dsw-alias-text-primary, #f2f2f7)'
    hasAny = true
  } else {
    if (style.fg) { out.color = style.fg; hasAny = true }
    if (style.bg) { out.backgroundColor = style.bg; hasAny = true }
  }
  return hasAny ? out : undefined
}
