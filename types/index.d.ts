// neocode's $.state contract: the session values its drawings read.
//   enabled  the person's toggle (/neocode on|off), mirrored to $.store
//   paused   true while the transcript is scrolled away from the live bottom
//   layout   bumped when the transcript's geometry changes, so overlays re-measure

/** Whether the effect is on, as the person last toggled it. */
export type NeocodeToggle = boolean

declare module 'claude-code' {
  interface PluginState {
    'neocode': { enabled: NeocodeToggle; paused: boolean; layout: number }
  }
}
