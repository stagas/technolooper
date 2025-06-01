import { looper, type Stem } from './looper.ts'

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => looper.init())
} else {
  looper.init()
}

// Set up directory callback
looper.onDirectoryLoaded(async (handle) => {
  console.log('Directory loaded callback:', handle.name)

  // Find and log ZIP files
  const zipFiles = await looper.findZipFiles(handle)
  console.log('Found ZIP files:', zipFiles)

  const audio = new AudioContext()

  // Phase 1: Read all ZIP file metadata (fast)
  console.log('Phase 1: Reading all ZIP metadata...')
  looper.updateLoadingStatus(`Reading ${zipFiles.length} ZIP files...`)

  const allStemMetadata = []
  for (const file of zipFiles) {
    console.log(`Reading metadata from ${file.name}...`)
    looper.updateLoadingStatus(`Reading ${file.name}...`)

    try {
      const stemMetadata = await looper.readZipFileMetadata(handle, file.name)
      allStemMetadata.push(...stemMetadata)

      // Add metadata to grid immediately (shows stem info but with loading state)
      looper.addStemMetadataToGrid(stemMetadata)

      console.log(`Added ${stemMetadata.length} stems metadata from ${file.name}`)
    } catch (error) {
      console.error(`Error reading metadata from ${file.name}:`, error)
    }
  }

  console.log(`Total stems to decode: ${allStemMetadata.length}`)
  looper.updateLoadingStatus(`Decoding ${allStemMetadata.length} audio files...`)

  // Phase 2: Progressively decode audio buffers
  console.log('Phase 2: Decoding audio progressively...')
  let decodedCount = 0
  for (let i = 0; i < allStemMetadata.length; i++) {
    const metadata = allStemMetadata[i]
    try {
      console.log(`Decoding audio ${decodedCount + 1}/${allStemMetadata.length}: ${metadata.name}`)
      looper.updateLoadingStatus(`Decoding ${decodedCount + 1}/${allStemMetadata.length}: ${metadata.name}`)

      const audioBuffer = await looper.decodeAudioForStem(audio, metadata.zipFile)

      // Update the specific cell with the decoded audio
      looper.updateCellWithAudioBuffer(i, audioBuffer)

      decodedCount++
      console.log(`✓ Decoded ${metadata.name} (${decodedCount}/${allStemMetadata.length})`)
    } catch (error) {
      console.error(`Error decoding audio for ${metadata.name}:`, error)
      // Leave the cell in loading state or mark as error
    }
  }

  console.log('All audio decoding complete!')
  looper.updateLoadingStatus('Ready to play! Click "Start Audio" when ready.')
})

looper.onCellsUpdated((activeCells) => {
  console.log('Active cells:', activeCells)
  const activeStems = looper.getActiveStems()
  console.log('Active stems:', activeStems.map(stem => `${stem.name} (${stem.kind})`))

  // Show audio status with musical timing
  if (looper.isAudioReady()) {
    const position = looper.getMusicalPosition()
    const bpm = looper.getMasterBPM()
    console.log(`🎵 Playing ${activeStems.length} stems | ${bpm} BPM | Bar ${position.bar}, Beat ${position.beat}`)
  } else {
    console.log('⏸️ Audio not initialized - click anywhere to start')
  }
})

looper.onStemsLoaded((stems) => {
  console.log('New stems added to grid:', stems.map(stem => `${stem.name} (${stem.kind})`))
})

// Create a named controller object for testing
export const controller = {
  // Helper functions for testing
  playAll: () => {
    looper.activateAll()
    console.log('🎵 Playing all stems')
  },
  stopAll: () => {
    looper.resetGrid()
    console.log('⏹️ Stopped all stems')
  },
  setVolume: (vol: number) => {
    looper.setMasterVolume(vol)
    console.log(`🔊 Volume set to ${vol}`)
  },
  setBPM: (bpm: number) => {
    looper.setMasterBPM(bpm)
    console.log(`🥁 BPM set to ${bpm}`)
  },
  getPosition: () => {
    const pos = looper.getMusicalPosition()
    console.log(`📍 Bar ${pos.bar}, Beat ${pos.beat}`)
    return pos
  },
  // Expose the main looper for advanced usage
  looper
}
