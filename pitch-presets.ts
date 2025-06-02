export interface PitchPreset {
  name: string
  ratio: number // Pitch ratio (0.25 to 4)
}

export const pitchPresets: PitchPreset[] = [
  { name: 'Normal', ratio: 1 },
  { name: 'Octave Down', ratio: 0.5 },
  { name: 'Perfect 5th Down', ratio: 0.667 },
  { name: 'Perfect 4th Down', ratio: 0.75 },
  { name: 'Major 3rd Down', ratio: 0.8 },
  { name: 'Minor 3rd Down', ratio: 0.833 },
  { name: 'Whole Tone Down', ratio: 0.889 },
  { name: 'Semitone Down', ratio: 0.944 },
  { name: 'Semitone Up', ratio: 1.059 },
  { name: 'Whole Tone Up', ratio: 1.125 },
  { name: 'Minor 3rd Up', ratio: 1.2 },
  { name: 'Major 3rd Up', ratio: 1.25 },
  { name: 'Perfect 4th Up', ratio: 1.333 },
  { name: 'Perfect 5th Up', ratio: 1.5 },
  { name: 'Octave Up', ratio: 2 },
  { name: 'Two Octaves Up', ratio: 4 }
]
