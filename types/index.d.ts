// neocode's $.state contract: the session values its drawings read.
//   enabled    the person's toggle (/neocode on|off), mirrored to $.store
//   paused     true while the person is scrolling or selecting
//   layout     bumped when the transcript's geometry changes, so overlays re-measure
//   keptClean  the transcript row a selection lies in, kept free of rain

/** Whether the effect is on, as the person last toggled it. */
export type NeocodeToggle = boolean

declare module 'claude-code' {
  interface PluginState {
    'neocode': { enabled: NeocodeToggle; paused: boolean; layout: number; keptClean: string }
  }
}
