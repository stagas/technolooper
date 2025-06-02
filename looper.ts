export * from './types.ts'
import type { Stem, StemKind, StemCell, ControlState, CellParameters, MasterEffectParameters } from './types.ts'
import {
  selectDirectory,
  loadSavedDirectory,
  findZipFiles,
  readZipFileMetadata,
  decodeAudioForStem,
  readZipFile,
  directoryHandle,
  setOnDirectoryLoaded
} from './file-manager.ts'
import {
  gridCells,
  initializeGrid,
  createGrid,
  addStemsToGrid,
  preallocateLoadingCells,
  fillPreallocatedCells,
  setCellLoading,
  addStemMetadataToGrid,
  updateCellWithAudioBuffer,
  updateCellVisual,
  updateCellVisuals,
  getActiveCells,
  getActiveStems,
  showGrid,
  showDirectoryPicker,
  setGridSize,
  getGridSize,
  getGridCells
} from './grid.ts'
import { NodePool } from './node-pool.ts'
import { AudioScheduler } from './audio-scheduler.ts'
import { delayPresets } from './delay-presets.ts'
import {
  initializeControls,
  setupControlRowEventListeners,
  enterCellSelectionMode,
  selectCellForControl,
  returnToInitialControlState,
  updateControlsAvailability,
  getControlState,
  getMasterEffectParameters,
  handleLoopFractionChange,
  handleBPMDelaySync
} from './controls.ts'

// Loading state tracking
let isLoadingStems = false
let originalUrlActiveParam: string | null = null
let totalStemsToLoad = 0
let loadedStemsCount = 0

// Callback for when cells are updated
let onCellsUpdate: ((activeCells: number[]) => void) | null = null
let onStemsLoadedCallback: ((stems: Stem[]) => void) | null = null

// Parameter values for each cell
const cellParameters = new Map<number, CellParameters>()

// Initialize default parameters for a cell
function initializeCellParameters(cellIndex: number): void {
  if (!cellParameters.has(cellIndex)) {
    cellParameters.set(cellIndex, {
      loopFraction: 1, // Full loop by default
      volume: 1,
      filter: 0, // No filter by default
      delayWet: 0,
      delayTime: 0,
      delayFeedback: 0.3 // Default feedback, matches worklet default pre-control
    })
  }
}

// Get parameters for a cell
function getCellParameters(cellIndex: number): CellParameters {
  initializeCellParameters(cellIndex)
  return cellParameters.get(cellIndex)!
}

// Set parameter for a cell
function setCellParameter(cellIndex: number, parameter: keyof CellParameters, value: number): void {
  initializeCellParameters(cellIndex)
  const params = cellParameters.get(cellIndex)!
  const oldValue = params[parameter]

  // Apply safety caps for specific parameters
  if (parameter === 'delayFeedback') {
    value = Math.min(0.90, Math.max(0, value)) // Cap feedback at 0.90
  } else if (parameter === 'volume') {
    value = Math.min(1, Math.max(0, value)) // Cap volume at 1.0
  } else if (parameter === 'delayWet') {
    value = Math.min(1, Math.max(0, value)) // Cap wet at 1.0
  }

  params[parameter] = value

  // Handle pooled node assignment/release for delay
  if (parameter === 'delayWet') {
    if (oldValue === 0 && value > 0) {
      // Starting to use delay - try to assign a node
      const assignedNode = nodePool.assignDelayNode(cellIndex)
      if (!assignedNode) {
        // No nodes available, reset parameter
        params[parameter] = 0
        console.warn(`No delay nodes available for cell ${cellIndex}`)
        return
      }
    }

    else if (oldValue > 0 && value === 0) {
      // Stopping delay use - release the node
      nodePool.releaseDelayNode(cellIndex)
    }
  }

  // Handle pooled node assignment/release for filter
  if (parameter === 'filter') {
    if (oldValue === 0 && value !== 0) {
      // Starting to use filter - try to assign a node
      const assignedNode = nodePool.assignFilterNode(cellIndex)
      if (!assignedNode) {
        // No nodes available, reset parameter
        params[parameter] = 0
        console.warn(`No filter nodes available for cell ${cellIndex}`)
        return
      }
    }

    else if (oldValue !== 0 && value === 0) {
      // Stopping filter use - release the node
      nodePool.releaseFilterNode(cellIndex)
    }
  }

  // Update audio if this cell is currently playing
  if (audioScheduler.isAudioInitialized() && gridCells[cellIndex]?.isActive) {
    // If we're changing delay/filter and need to restart with new nodes
    if ((parameter === 'delayWet' && ((oldValue === 0) !== (value === 0))) ||
      (parameter === 'filter' && ((oldValue === 0) !== (value === 0)))) {
      // Restart the stem to reconnect with new pooled nodes
      const stem = gridCells[cellIndex].stem
      if (stem) {
        audioScheduler.removeStem(cellIndex)
        audioScheduler.addStem(cellIndex, stem, getCellParameters)
      }
    }

    else {
      audioScheduler.updateCellParameter(cellIndex, parameter, value, getCellParameters, setCellParameter)
    }
  }

  // Update visuals to show new pool assignments
  updateCellVisual(cellIndex, getCellParameters, nodePool)

  // Update controls availability when pool state changes
  if (parameter === 'delayWet' || parameter === 'filter') {
    updateControlsAvailability()
  }
}

// Trigger callback with current active cells
function triggerCellsUpdateCallback(): void {
  if (onCellsUpdate) {
    const activeCells = getActiveCells()
    onCellsUpdate(activeCells)
  }
  updateUrlWithActiveCells()

  // Update audio scheduler with new active stems
  if (audioScheduler.isAudioInitialized()) {
    audioScheduler.updateActiveStems(getActiveCells(), gridCells, getCellParameters).catch(error => {
      console.error('Error updating active stems:', error)
    })
  }
}

// Update URL with current active cells
function updateUrlWithActiveCells(): void {
  // Don't update URL while stems are loading to preserve original state
  if (isLoadingStems) {
    return
  }

  const activeCells = getActiveCells()
  const url = new URL(window.location.href)

  if (activeCells.length > 0) {
    url.searchParams.set('active', activeCells.join(','))
  } else {
    url.searchParams.delete('active')
  }

  // Update URL without refreshing the page
  window.history.replaceState({}, '', url.toString())
}

// Load active cells from URL
function loadActiveCellsFromUrl(): void {
  const urlParams = new URLSearchParams(window.location.search)
  const activeParam = originalUrlActiveParam || urlParams.get('active')

  if (activeParam) {
    const activeIndices = activeParam.split(',').map(str => parseInt(str.trim(), 10))

    // Validate and apply active cells - allow activation with metadata even if audio is loading
    activeIndices.forEach(index => {
      if (index >= 0 && index < getGridSize() && !isNaN(index)) {
        const cell = gridCells[index]
        // Only require that cell has a stem (metadata loaded) - audio can still be loading
        if (cell && cell.stem) {
          cell.isActive = true
        }
      }
    })

    updateCellVisuals(getCellParameters, nodePool)
    // Don't trigger callback that updates URL during loading
    if (!isLoadingStems) {
      triggerCellsUpdateCallback()
    }
  }
}

// Toggle cell state
function toggleCell(index: number): void {
  if (index < 0 || index >= getGridSize()) return

  // Handle control mode
  const controlState = getControlState()
  if (controlState.isActive && controlState.mode === 'cellSelection') {
    // Select this cell for control
    if (gridCells[index].stem) {
      selectCellForControl(index)
    }
    return
  }

  // Normal toggle behavior
  if (gridCells[index].stem) {
    const wasActive = gridCells[index].isActive
    gridCells[index].isActive = !gridCells[index].isActive

    // If cell became inactive, release any pooled nodes
    if (wasActive && !gridCells[index].isActive) {
      const params = getCellParameters(index)
      if (params.delayWet > 0) {
        nodePool.releaseDelayNode(index)
        params.delayWet = 0
      }
      if (params.filter !== 0) {
        nodePool.releaseFilterNode(index)
        params.filter = 0
      }
      updateControlsAvailability()
    }

    updateCellVisual(index, getCellParameters, nodePool)
    triggerCellsUpdateCallback()
  }
}

// Audio overlay management
function showAudioOverlay(): void {
  const overlay = document.getElementById('audioOverlay')
  if (overlay) {
    overlay.classList.remove('hidden')
  }
}

function hideAudioOverlay(): void {
  const overlay = document.getElementById('audioOverlay')
  if (overlay) {
    overlay.classList.add('hidden')
  }
}

function updateLoadingStatus(message: string): void {
  const status = document.getElementById('loadingStatus')
  if (status) {
    status.textContent = message
  }
}

async function setupAudioButton(): Promise<void> {
  const startBtn = document.getElementById('startAudioBtn')
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.textContent = '⏳ Starting...'
        ; (startBtn as HTMLButtonElement).disabled = true

      try {
        await audioScheduler.initializeAudio()
        audioScheduler.start()

        // Update with current active cells if any
        await audioScheduler.updateActiveStems(getActiveCells(), gridCells, getCellParameters)

        hideAudioOverlay()
        console.log('🎵 Audio engine started!')
      } catch (error) {
        console.error('Failed to start audio:', error)
        startBtn.textContent = '❌ Failed - Try Again'
          ; (startBtn as HTMLButtonElement).disabled = false
      }
    })
  }
}

// Initialize the application
async function init(): Promise<void> {
  console.log('Initializing application')

  const urlParams = new URLSearchParams(window.location.search)
  const sizeParam = urlParams.get('size')

  if (sizeParam) {
    const parsedSize = parseInt(sizeParam, 10)
    if (parsedSize > 0 && parsedSize <= 1024) {
      setGridSize(parsedSize)
    }
  }

  // Show audio overlay initially
  showAudioOverlay()
  await setupAudioButton()

  // Set up directory picker button
  const selectBtn = document.getElementById('selectDirectoryBtn')
  if (selectBtn) {
    console.log('Setting up directory picker button event listener')
    selectBtn.addEventListener('click', () => {
      console.log('Directory picker button clicked')
      selectDirectory()
    })
  } else {
    console.error('Could not find selectDirectoryBtn element')
  }

  // Try to load saved directory first
  console.log('Attempting to load saved directory')
  const hasDirectory = await loadSavedDirectory()

  if (hasDirectory) {
    console.log('Saved directory found, initializing grid')
    // Directory loaded, initialize grid
    initializeGrid()
    setupEventListeners()
    // Don't load URL state here - wait for stems to be loaded
  } else {
    console.log('No saved directory, showing directory picker')
    // No directory, show picker - but still need to set up basic grid structure
    setupEventListeners()
    showDirectoryPicker()
  }
}

// Setup event listeners
let eventListenersSetup = false
function setupEventListeners(): void {
  // Prevent multiple calls
  if (eventListenersSetup) {
    console.log('⚠️ setupEventListeners already called, skipping')
    return
  }
  eventListenersSetup = true
  console.log('🎧 Setting up event listeners')

  // Initialize controls with dependencies
  initializeControls({
    getGridCells: () => gridCells,
    getCellParameters,
    setCellParameter,
    getNodePool: () => nodePool,
    getAudioScheduler: () => audioScheduler
  })

  // Initialize audio on first user interaction
  let audioInitialized = false

  async function initializeAudioOnFirstInteraction(): Promise<void> {
    if (!audioInitialized) {
      audioInitialized = true
      try {
        await audioScheduler.initializeAudio()
        audioScheduler.start()
        // Update with current active cells
        await audioScheduler.updateActiveStems(getActiveCells(), gridCells, getCellParameters)
      } catch (error) {
        console.error('Error initializing audio:', error)
      }
    }
  }

  // Setup control row event listeners
  setupControlRowEventListeners()

  // Handle window resize
  let resizeTimeout: any
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout)
    resizeTimeout = setTimeout(() => {
      createGrid(toggleCell)
    }, 150)
  })

  // Initialize audio on first pointer interaction
  document.addEventListener('pointerdown', initializeAudioOnFirstInteraction, { once: true })
  document.addEventListener('click', initializeAudioOnFirstInteraction, { once: true })

  // Prevent default touch behaviors on the grid
  const container = document.getElementById('grid') as HTMLElement
  if (container) {
    container.addEventListener('touchstart', (e) => {
      e.preventDefault()
    }, { passive: false })

    container.addEventListener('touchmove', (e) => {
      e.preventDefault()
    }, { passive: false })
  }

  // Handle keyboard shortcuts (optional enhancement)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      // Allow copy
      return
    }

    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      // Reset all cells
      gridCells.forEach(cell => cell.isActive = false)
      updateCellVisuals(getCellParameters, nodePool)
      triggerCellsUpdateCallback()
    }

    if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      // Activate all cells with stems
      gridCells.forEach(cell => {
        if (cell.stem) cell.isActive = true
      })
      updateCellVisuals(getCellParameters, nodePool)
      triggerCellsUpdateCallback()
    }

    if (e.key === ' ') {
      e.preventDefault()
      // Toggle play/pause
      if (audioScheduler.isAudioInitialized()) {
        // This could be expanded to include play/pause functionality
        console.log('Space pressed - could implement play/pause')
      }
    }

    // ESC key to return to initial control state
    if (e.key === 'Escape') {
      e.preventDefault()
      returnToInitialControlState()
    }
  })

  // Rate buttons - set up with event delegation
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.classList.contains('rate-btn')) {
      const fraction = parseFloat(target.getAttribute('data-fraction') || '1')
      handleLoopFractionChange(fraction)
    }
  })

  // BPM delay sync buttons - set up with event delegation
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.classList.contains('delay-sync-btn')) {
      const fraction = parseFloat(target.getAttribute('data-fraction') || '0.25')
      handleBPMDelaySync(fraction)
    }
  })
}

// Set callback for cell updates
function onCellsUpdated(callback: ((activeCells: number[]) => void) | null): void {
  onCellsUpdate = callback
}

// Set callback for when stems are loaded
function setOnStemsLoaded(callback: ((stems: Stem[]) => void) | null): void {
  onStemsLoadedCallback = callback
}

function resetGrid(): void {
  gridCells.forEach(cell => cell.isActive = false)
  updateCellVisuals(getCellParameters, nodePool)
  triggerCellsUpdateCallback()
}

function activateAll(): void {
  gridCells.forEach(cell => {
    if (cell.stem) cell.isActive = true
  })
  updateCellVisuals(getCellParameters, nodePool)
  triggerCellsUpdateCallback()
}

// Create global instances
const nodePool = new NodePool()
const audioScheduler = new AudioScheduler(nodePool)

// Enhanced grid functions that maintain original interface
function enhancedAddStemsToGrid(stems: Stem[]): void {
  addStemsToGrid(stems)

  // Recreate the grid with new size
  createGrid(toggleCell)

  // Re-apply URL state after each batch of stems is loaded
  loadActiveCellsFromUrl()

  if (onStemsLoadedCallback) {
    onStemsLoadedCallback(stems)
  }
}

function enhancedAddStemMetadataToGrid(stemMetadata: Array<{
  name: string
  bpm: number
  kind: StemKind
  fileName: string
  zipFile: any
}>): void {
  // Store original URL state on first load
  if (!isLoadingStems) {
    isLoadingStems = true
    const urlParams = new URLSearchParams(window.location.search)
    originalUrlActiveParam = urlParams.get('active')
    loadedStemsCount = 0
  }

  // Track total stems to load
  totalStemsToLoad += stemMetadata.length

  addStemMetadataToGrid(stemMetadata)

  // Recreate the grid with new size
  createGrid(toggleCell)

  // Apply URL state after metadata is loaded (but don't update URL yet)
  loadActiveCellsFromUrl()

  if (onStemsLoadedCallback) {
    const stemsWithoutBuffer = stemMetadata.map(meta => ({
      name: meta.name,
      bpm: meta.bpm,
      kind: meta.kind,
      buffer: null as any
    }))
    onStemsLoadedCallback(stemsWithoutBuffer)
  }
}

function enhancedUpdateCellWithAudioBuffer(cellIndex: number, audioBuffer: AudioBuffer): void {
  updateCellWithAudioBuffer(cellIndex, audioBuffer)
  updateCellVisual(cellIndex, getCellParameters, nodePool)

  // Track loading progress
  loadedStemsCount++

  // Re-apply URL state in case this cell should be active
  loadActiveCellsFromUrl()

  // Check if all stems are loaded
  if (loadedStemsCount >= totalStemsToLoad) {
    console.log('All stems loaded! Resuming URL updates.')
    isLoadingStems = false
    originalUrlActiveParam = null
    totalStemsToLoad = 0
    loadedStemsCount = 0

    // Now trigger normal URL update
    triggerCellsUpdateCallback()
  }
}

function enhancedPreallocateLoadingCells(estimatedCount: number): number[] {
  const indices = preallocateLoadingCells(estimatedCount)

  // Recreate the grid with loading cells
  createGrid(toggleCell)

  return indices
}

function enhancedFillPreallocatedCells(startIndex: number, stems: Stem[]): void {
  fillPreallocatedCells(startIndex, stems)

  // Recreate grid if size changed
  createGrid(toggleCell)

  // Apply URL state after filling cells
  loadActiveCellsFromUrl()

  if (onStemsLoadedCallback) {
    onStemsLoadedCallback(stems)
  }
}

function enhancedSetCellLoading(indices: number[], loading: boolean): void {
  setCellLoading(indices, loading)

  indices.forEach(index => {
    updateCellVisual(index, getCellParameters, nodePool)
  })
}

// Set up directory callback hook
setOnDirectoryLoaded(async (handle) => {
  console.log('Directory loaded, initializing grid')

  // Initialize grid if not already done
  if (getGridCells().length === 0) {
    initializeGrid()
    setupEventListeners()
    // Don't load URL state here - wait for stems to be loaded
  }

  // Don't show grid yet - wait for stems to be loaded
  // Grid will be shown when first stems are added
})

// Create the looper controller object - maintaining exact same interface as original
export const looper = {
  init: (): Promise<void> => init(),

  // Set the number of grid cells
  setGridCells: (size: number): void => {
    if (size > 0 && size <= 1024) {
      const previousSize = getGridSize()
      setGridSize(size)

      // Initialize new grid
      initializeGrid()
      createGrid(toggleCell)

      // If grid size changed, load from URL or trigger callback for empty state
      if (previousSize !== size) {
        loadActiveCellsFromUrl()
      } else {
        // Same size, just trigger callback to maintain URL sync
        triggerCellsUpdateCallback()
      }
    }
  },

  // Toggle a specific cell
  toggleCell: (index: number): void => {
    toggleCell(index)
  },

  // Reset all cells to inactive
  resetGrid: (): void => {
    resetGrid()
  },

  // Activate all cells
  activateAll: (): void => {
    activateAll()
  },

  // Set callback for cell updates
  onCellsUpdated: (callback: ((activeCells: number[]) => void) | null): void => {
    onCellsUpdated(callback)
  },

  // Set callback for when stems are loaded
  onStemsLoaded: (callback: ((stems: Stem[]) => void) | null): void => {
    setOnStemsLoaded(callback)
  },

  // Get current active cells
  getActiveCells: (): number[] => {
    return getActiveCells()
  },

  // Get current active stems
  getActiveStems: (): Stem[] => {
    return getActiveStems()
  },

  // Get current grid size
  getGridSize: (): number => {
    return getGridSize()
  },

  // Add stems to grid
  addStemsToGrid: (stems: Stem[]): void => {
    enhancedAddStemsToGrid(stems)
  },

  // Pre-allocate loading cells
  preallocateLoadingCells: (estimatedCount: number): number[] => {
    return enhancedPreallocateLoadingCells(estimatedCount)
  },

  // Fill pre-allocated cells with stems
  fillPreallocatedCells: (startIndex: number, stems: Stem[]): void => {
    enhancedFillPreallocatedCells(startIndex, stems)
  },

  // Set loading state for cells
  setCellLoading: (indices: number[], loading: boolean): void => {
    enhancedSetCellLoading(indices, loading)
  },

  // Get grid cells
  getGridCells: (): StemCell[] => {
    return getGridCells()
  },

  // Add stems without audio buffers (metadata only)
  addStemMetadataToGrid: (stemMetadata: Array<{
    name: string
    bpm: number
    kind: StemKind
    fileName: string
    zipFile: any
  }>): void => {
    enhancedAddStemMetadataToGrid(stemMetadata)
  },

  // Update a specific cell with decoded audio buffer
  updateCellWithAudioBuffer: (cellIndex: number, audioBuffer: AudioBuffer): void => {
    enhancedUpdateCellWithAudioBuffer(cellIndex, audioBuffer)
  },

  // Directory methods
  selectDirectory: (): Promise<void> => {
    return selectDirectory()
  },

  getDirectoryHandle: (): FileSystemDirectoryHandle | null => {
    return directoryHandle
  },

  onDirectoryLoaded: (callback: ((handle: FileSystemDirectoryHandle) => void | Promise<void>) | null): void => {
    setOnDirectoryLoaded(callback)
  },

  showDirectoryPicker: (): void => {
    showDirectoryPicker()
  },

  findZipFiles,
  readZipFile,
  readZipFileMetadata,
  decodeAudioForStem,

  // Audio Scheduler controls
  initializeAudio: (): Promise<void> => {
    return audioScheduler.initializeAudio()
  },

  startPlayback: (): void => {
    audioScheduler.start()
  },

  stopPlayback: (): void => {
    audioScheduler.stop()
  },

  setMasterVolume: (volume: number): void => {
    audioScheduler.setMasterVolume(volume)
  },

  isAudioReady: (): boolean => {
    return audioScheduler.isAudioInitialized()
  },

  // Musical timing controls
  setMasterBPM: (bpm: number): void => {
    audioScheduler.setMasterBPM(bpm)
  },

  getMasterBPM: (): number => {
    return audioScheduler.getMasterBPM()
  },

  getMusicalPosition: (): { bar: number, beat: number, position: number } => {
    return audioScheduler.getMusicalPosition()
  },

  // Control system
  enterCellSelectionMode: (): void => {
    enterCellSelectionMode()
  },

  returnToInitialControlState: (): void => {
    returnToInitialControlState()
  },

  getControlState: (): ControlState => {
    return getControlState()
  },

  setCellParameter: (cellIndex: number, parameter: keyof CellParameters, value: number): void => {
    setCellParameter(cellIndex, parameter, value)
  },

  getCellParameters: (cellIndex: number): CellParameters => {
    return getCellParameters(cellIndex)
  },

  // Audio overlay management
  updateLoadingStatus,

  // Node pool management
  getNodePool: () => nodePool,

  updateControlsAvailability: () => updateControlsAvailability(),

  // Debug helper for testing pool system
  debugPools: () => {
    const delayAvailable = nodePool.getAvailableDelayCount()
    const filterAvailable = nodePool.getAvailableFilterCount()
    console.log(`Pool Status: Delay ${delayAvailable}/8 available, Filter ${filterAvailable}/8 available`)

    // Show which cells are using pooled nodes
    for (let i = 0; i < gridCells.length; i++) {
      const params = getCellParameters(i)
      if (params.delayWet > 0) {
        const delayIndex = nodePool.getDelayNodeIndex(i)
        console.log(`Cell ${i}: Using delay node ${delayIndex}`)
      }
      if (params.filter !== 0) {
        const filterIndex = nodePool.getFilterNodeIndex(i)
        console.log(`Cell ${i}: Using filter node ${filterIndex}`)
      }
    }

    return { delayAvailable, filterAvailable }
  },

  // Master effect parameters
  getMasterEffectParameters: () => getMasterEffectParameters(),
}
