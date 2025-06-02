import { looper, type Stem } from './looper.ts'

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', async () => {
    await looper.init()
    // Debug: Check if control row exists
    setTimeout(() => {
      const controlRow = document.getElementById('controlRow')
      console.log('Control row element:', controlRow)
      if (controlRow) {
        console.log('Control row display:', controlRow.style.display)
        console.log('Control row computed style:', window.getComputedStyle(controlRow).display)
      } else {
        console.log('❌ Control row element not found!')
      }
    }, 1000)
  })
} else {
  looper.init().then(() => {
    // Debug: Check if control row exists
    setTimeout(() => {
      const controlRow = document.getElementById('controlRow')
      console.log('Control row element:', controlRow)
      if (controlRow) {
        console.log('Control row display:', controlRow.style.display)
        console.log('Control row computed style:', window.getComputedStyle(controlRow).display)
      } else {
        console.log('❌ Control row element not found!')
      }
    }, 1000)
  }).catch(error => {
    console.error('Error initializing looper:', error)
  })
}

// Set up directory callback
looper.onDirectoryLoaded(async (handle) => {
  console.log('Directory loaded callback:', handle.name)

  // Find and log ZIP files
  const zipFiles = await looper.findZipFiles(handle)
  console.log('Found ZIP files:', zipFiles)

  const audio = new AudioContext()

  // Single phase: Process each ZIP file completely before moving to the next
  console.log('Processing ZIP files one at a time...')
  looper.updateLoadingStatus(`Processing ${zipFiles.length} ZIP files...`)

  let totalProcessedStems = 0

  for (let fileIndex = 0; fileIndex < zipFiles.length; fileIndex++) {
    const file = zipFiles[fileIndex]
    console.log(`Processing ${file.name} (${fileIndex + 1}/${zipFiles.length})...`)
    looper.updateLoadingStatus(`Processing ${file.name} (${fileIndex + 1}/${zipFiles.length})...`)

    try {
      // Read metadata for this ZIP file
      const stemMetadata = await looper.readZipFileMetadata(handle, file.name)
      console.log(`Found ${stemMetadata.length} stems in ${file.name}`)

      // Process each stem in this ZIP file immediately
      const processedStems: any[] = []

      for (let stemIndex = 0; stemIndex < stemMetadata.length; stemIndex++) {
        const metadata = stemMetadata[stemIndex]
        const currentStem = totalProcessedStems + stemIndex + 1
        const totalEstimated = zipFiles.length * (stemMetadata.length || 5) // Rough estimate

        try {
          console.log(`Decoding ${currentStem}: ${metadata.name}`)
          looper.updateLoadingStatus(`Decoding ${currentStem}: ${metadata.name}`)

          // Decode audio buffer for this stem
          const audioBuffer = await looper.decodeAudioForStem(audio, metadata.zipFile)

          // Create complete stem object with audio buffer
          const completeStem = {
            name: metadata.name,
            bpm: metadata.bpm,
            kind: metadata.kind,
            buffer: audioBuffer
          }

          processedStems.push(completeStem)
          console.log(`✓ Processed ${metadata.name}`)

        } catch (error) {
          console.error(`Error processing stem ${metadata.name}:`, error)
          // Continue with other stems in this ZIP
        }
      }

      // Add all processed stems from this ZIP file to the grid at once
      if (processedStems.length > 0) {
        looper.addStemsToGrid(processedStems)
        totalProcessedStems += processedStems.length
        console.log(`✓ Added ${processedStems.length} stems from ${file.name} to grid`)
      }

      // Clean up - explicitly clear references to help garbage collection
      stemMetadata.length = 0
      processedStems.length = 0

    } catch (error) {
      console.error(`Error processing ZIP file ${file.name}:`, error)
      // Continue with next ZIP file
    }

    // Force garbage collection hint (if available)
    if ('gc' in window && typeof (window as any).gc === 'function') {
      (window as any).gc()
    }
  }

  console.log(`All processing complete! Total stems: ${totalProcessedStems}`)
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
  // Debug function to check control row
  showControlRow: () => {
    const controlRow = document.getElementById('controlRow')
    console.log('Manual control row check:', controlRow)
    if (controlRow) {
      controlRow.style.display = 'flex'
      console.log('✅ Control row forced to show')
    } else {
      console.log('❌ Control row not found')
    }
  },
  hideControlRow: () => {
    const controlRow = document.getElementById('controlRow')
    if (controlRow) {
      controlRow.style.display = 'none'
      console.log('✅ Control row hidden')
    }
  },
  // Expose the main looper for advanced usage
  looper
}
