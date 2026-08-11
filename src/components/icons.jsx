// Inline stroke icons — no icon package, no CDN (a Pages CSP would block one).
// All share a 24px grid and inherit colour, so they tint with the nav state.
const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
}

const Svg = ({ size = 22, children, ...rest }) => (
  <svg {...base} width={size} height={size} {...rest}>
    {children}
  </svg>
)

export const IconHome = p => (
  <Svg {...p}>
    <path d="M3.5 10.6 12 3.8l8.5 6.8" />
    <path d="M5.8 9.4V20h12.4V9.4" />
    <path d="M10 20v-5h4v5" />
  </Svg>
)

export const IconClientNew = p => (
  <Svg {...p}>
    <circle cx="9.5" cy="8" r="3.4" />
    <path d="M3.5 20c0-3.3 2.7-5.6 6-5.6 1 0 2 .2 2.8.6" />
    <path d="M17.5 14.5v6M14.5 17.5h6" />
  </Svg>
)

export const IconClientEdit = p => (
  <Svg {...p}>
    <circle cx="9.5" cy="8" r="3.4" />
    <path d="M3.5 20c0-3.3 2.7-5.6 6-5.6h.8" />
    <path d="M20.4 13.9 15 19.3l-2.6.6.6-2.6 5.4-5.4a1.3 1.3 0 0 1 1.9 0l.1.1a1.3 1.3 0 0 1 0 1.9Z" />
  </Svg>
)

export const IconCommissioning = p => (
  <Svg {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1.6" />
    <path d="M10.2 10.2h3.6v3.6h-3.6z" />
    <path d="M10 7V4.4M14 7V4.4M10 19.6V17M14 19.6V17M7 10H4.4M7 14H4.4M19.6 10H17M19.6 14H17" />
  </Svg>
)

export const IconMaintenance = p => (
  <Svg {...p}>
    <path d="M8.6 4.6H7.2A1.7 1.7 0 0 0 5.5 6.3v13A1.7 1.7 0 0 0 7.2 21h9.6a1.7 1.7 0 0 0 1.7-1.7v-13a1.7 1.7 0 0 0-1.7-1.7h-1.4" />
    <rect x="8.6" y="3" width="6.8" height="3.2" rx="1.1" />
    <path d="m9.4 13.4 1.9 1.9 3.5-3.9" />
  </Svg>
)

export const IconList = p => (
  <Svg {...p}>
    <path d="M9 6.5h11M9 12h11M9 17.5h7" />
    <circle cx="4.6" cy="6.5" r="1.2" />
    <circle cx="4.6" cy="12" r="1.2" />
    <circle cx="4.6" cy="17.5" r="1.2" />
  </Svg>
)

// Two people rather than one: the page is about who is in a team, and the
// single-figure marks are already spoken for by the client pages.
export const IconTeams = p => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3.4" />
    <path d="M3 20c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6" />
    <path d="M16.2 5.1a3.4 3.4 0 0 1 0 6.5" />
    <path d="M17.6 14.8c2 .7 3.4 2.5 3.4 5.2" />
  </Svg>
)

export const IconSettings = p => (
  <Svg {...p}>
    <path d="M4 7.5h6M14 7.5h6M4 16.5h4M12 16.5h8" />
    <circle cx="12" cy="7.5" r="2.1" />
    <circle cx="10" cy="16.5" r="2.1" />
  </Svg>
)

export const IconChevron = ({ size = 18, dir = 'left', ...rest }) => (
  <Svg size={size} {...rest} style={{ transform: dir === 'right' ? 'rotate(180deg)' : undefined }}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </Svg>
)

export const IconMenu = p => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
)

export const IconTrash = p => (
  <Svg {...p}>
    <path d="M4.5 7h15" />
    <path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7" />
    <path d="M6.4 7l.8 12.1A1.5 1.5 0 0 0 8.7 20.5h6.6a1.5 1.5 0 0 0 1.5-1.4L17.6 7" />
    <path d="M10.4 10.6v6.2M13.6 10.6v6.2" />
  </Svg>
)

export const IconClose = p => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

// Placeholder brand mark — a signal trace. Sized for a real logo asset later.
export const BrandMark = ({ size = 22, ...rest }) => (
  <Svg size={size} {...rest}>
    <path d="M3 12h3l2.5-7 4 14 3-9.5L18 12h3" />
  </Svg>
)
