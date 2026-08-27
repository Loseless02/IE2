/**
 * Tab groups: a name, a colour, and the tabs that belong to it.
 *
 * Colours are named rather than free-form hex. A group's colour has to work as
 * a chip background, as a strip under its tabs, and as a swatch in the picker,
 * on twenty-three themes — so each name resolves to a pair chosen to stay
 * legible rather than to whatever the user might type.
 */

export const TAB_GROUP_COLOURS = {
  grey: { name: 'Grey', fill: '#8a94a6', text: '#11131a' },
  blue: { name: 'Blue', fill: '#4f8cff', text: '#08101f' },
  red: { name: 'Red', fill: '#e0567c', text: '#210a12' },
  yellow: { name: 'Yellow', fill: '#e0a32e', text: '#211705' },
  green: { name: 'Green', fill: '#3fb984', text: '#04170f' },
  pink: { name: 'Pink', fill: '#f07ab5', text: '#25091a' },
  purple: { name: 'Purple', fill: '#a684ee', text: '#150a26' },
  cyan: { name: 'Cyan', fill: '#3bb8c4', text: '#04191b' },
  orange: { name: 'Orange', fill: '#f0873c', text: '#241005' }
} as const

export type TabGroupColour = keyof typeof TAB_GROUP_COLOURS

export const GROUP_COLOUR_IDS = Object.keys(TAB_GROUP_COLOURS) as TabGroupColour[]

/** Anything unrecognised falls back rather than leaving a chip unpainted. */
export function groupColour(id: string): (typeof TAB_GROUP_COLOURS)[TabGroupColour] {
  return TAB_GROUP_COLOURS[id as TabGroupColour] ?? TAB_GROUP_COLOURS.grey
}

/** The colour a new group takes, cycling so consecutive groups differ. */
export function nextGroupColour(used: string[]): TabGroupColour {
  const free = GROUP_COLOUR_IDS.find((id) => !used.includes(id))
  return free ?? GROUP_COLOUR_IDS[used.length % GROUP_COLOUR_IDS.length]
}
