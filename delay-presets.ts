import type { DelayPreset } from './types.ts'

export const delayPresets: DelayPreset[] = [
  { name: 'Off', wet: 0, feedback: 0, time: 0 },

  // Flanger Effects (1-10ms range)
  { name: 'Light Flanger', wet: 0.3, feedback: 0.15, time: 0.01 }, // ~2ms
  { name: 'Deep Flanger', wet: 0.5, feedback: 0.4, time: 0.02 }, // ~5ms
  { name: 'Jet Flanger', wet: 0.6, feedback: 0.7, time: 0.025 }, // ~8ms

  // Chorus Effects (5-30ms range)
  { name: 'Subtle Chorus', wet: 0.25, feedback: 0.05, time: 0.04 }, // ~15ms
  { name: 'Rich Chorus', wet: 0.4, feedback: 0.15, time: 0.06 }, // ~25ms

  // Short Delays
  { name: 'Tight Slap', wet: 0.15, feedback: 0.1, time: 0.08 }, // ~50ms
  { name: 'Room Slap', wet: 0.25, feedback: 0.25, time: 0.15 }, // ~120ms
  { name: 'Hall Echo', wet: 0.35, feedback: 0.35, time: 0.25 }, // ~250ms

  // BPM Synced Delays
  { name: '1/32 Note', wet: 0.25, feedback: 0.25, time: 0.2, syncFraction: 0.03125 },
  { name: '1/16 Note', wet: 0.3, feedback: 0.3, time: 0.3, syncFraction: 0.0625 },
  { name: '1/12 Note', wet: 0.3, feedback: 0.35, time: 0.35, syncFraction: 0.08333333333 },
  { name: '1/8 Note', wet: 0.35, feedback: 0.35, time: 0.4, syncFraction: 0.125 },
  { name: '1/6 Note', wet: 0.35, feedback: 0.4, time: 0.45, syncFraction: 0.16666666666 },
  { name: '1/4 Note', wet: 0.4, feedback: 0.4, time: 0.6, syncFraction: 0.25 },
  { name: '1/3 Note', wet: 0.4, feedback: 0.45, time: 0.7, syncFraction: 0.33333333333 },
  { name: '1/2 Note', wet: 0.45, feedback: 0.5, time: 0.8, syncFraction: 0.5 },

  // Long Delays & Reverbs
  { name: 'Medium Verb', wet: 0.4, feedback: 0.5, time: 0.65 }, // ~600ms
  { name: 'Long Verb', wet: 0.5, feedback: 0.6, time: 0.8 }, // ~1000ms
  { name: 'Cathedral', wet: 0.6, feedback: 0.7, time: 0.9 }, // ~1500ms

  // Special Effects
  { name: 'Pingpong', wet: 0.5, feedback: 0.8, time: 0.45 }, // ~400ms high feedback
  { name: 'Infinite', wet: 0.6, feedback: 0.9, time: 0.7 }, // Nearly self-oscillating
  { name: 'Chaos', wet: 0.7, feedback: 0.9, time: 0.55 } // High feedback, medium time
]
