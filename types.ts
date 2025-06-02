export interface Stem {
  name: string
  bpm: number
  kind: StemKind
  buffer: AudioBuffer
}

export enum StemKind {
  Drums = 'Drums',
  Bass = 'Bass',
  Percussion = 'Percussion',
  Others = 'Others',
  FX = 'FX',
  Chords = 'Chords',
  Pads = 'Pads',
  Keys = 'Keys',
  'Brass & Winds' = 'Brass & Winds',
  Strings = 'Strings',
  Guitar = 'Guitar',
  Leads = 'Leads',
  Synth = 'Synth',
  Vocals = 'Vocals',
}

export const StemColors = {
  'Drums': [240, 85, 60],      // Electric indigo - electronic, modern
  'Bass': [0, 90, 65],         // Electric red - powerful, foundational
  'Percussion': [30, 95, 60],  // Electric orange - rhythmic, energetic
  'Others': [300, 85, 60],     // Electric magenta - versatile, vibrant
  'FX': [270, 90, 65],         // Electric purple - special, mystical
  'Chords': [120, 85, 55],     // Electric green - harmonic, natural
  'Pads': [160, 80, 60],       // Electric teal - atmospheric, spacious
  'Keys': [60, 95, 65],        // Electric yellow - bright, melodic
  'Brass & Winds': [45, 90, 60], // Electric gold - brass warmth, rich
  'Strings': [180, 85, 60],    // Electric cyan - orchestral, flowing
  'Guitar': [15, 85, 60],      // Electric scarlet - rock energy
  'Leads': [90, 90, 65],       // Electric lime - standout melodies
  'Synth': [210, 90, 65],      // Electric blue - punchy, sharp
  'Vocals': [135, 85, 65],     // Electric jade - human, expressive
}

// Cell interface for stem-based cells
export interface StemCell {
  stem: Stem | null
  isActive: boolean
  isLoading: boolean
  element: HTMLElement | null
}

// Control system state
export interface ControlState {
  mode: 'initial' | 'cellSelection' | 'parameterControl' | 'masterEffects'
  controlledCellIndex: number | null
  currentParameter: string | null
  isActive: boolean
}

// Master effect parameters
export interface MasterEffectParameters {
  filter: number // -1 to 1 (negative = low-pass, positive = high-pass, 0 = no filter)
  delayWet: number // 0 to 1 (wet amount)
  delayTime: number // 0 to 1 (mapped exponentially to 0.1ms-2000ms)
  delayFeedback: number // 0 to 0.95 (feedback amount for worklet)
}

// Parameter values for each cell
export interface CellParameters {
  loopFraction: number // 1, 0.5, 0.25, 0.125, 0.0625 (full, 1/2, 1/4, 1/8, 1/16)
  volume: number // 0 to 1
  filter: number // -1 to 1 (negative = low-pass, positive = high-pass, 0 = no filter)
  delayWet: number // 0 to 1 (wet amount)
  delayTime: number // 0 to 1 (mapped exponentially to 0.1ms-2000ms)
  delayFeedback: number // 0 to 0.95 (feedback amount for worklet)
}

export interface PooledDelayNode {
  delayNode: AudioWorkletNode
  delayParams: { delay: AudioParam | undefined; feedback: AudioParam | undefined }
  delayWetNode: GainNode
  delayDryNode: GainNode
  isAvailable: boolean
  assignedCellIndex: number | null
}

export interface PooledFilterNode {
  filterNode: BiquadFilterNode
  isAvailable: boolean
  assignedCellIndex: number | null
}

export interface DelayPreset {
  name: string
  wet: number // 0-1
  feedback: number // 0-0.95
  time: number // 0-1 (exponential mapped)
  syncFraction?: number // Optional BPM sync fraction
}
