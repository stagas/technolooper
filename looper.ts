// Import idb-keyval for directory handle persistence
import { get, set } from 'idb-keyval'
import JSZip from 'jszip'

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

// Custom seeded random number generator for consistent colors
class SeededRandom {
  private seed: number

  constructor(seed: number = 12345) {
    this.seed = seed
  }

  next(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280
    return this.seed / 233280
  }

  range(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }
}

// Directory handle storage
let directoryHandle: FileSystemDirectoryHandle | null = null
const DIRECTORY_HANDLE_KEY = 'technolooper-directory-handle'

// Callback for when directory is loaded
let onDirectoryLoaded: ((handle: FileSystemDirectoryHandle) => void | Promise<void>) | null = null

// Loading state tracking
let isLoadingStems = false
let originalUrlActiveParam: string | null = null
let totalStemsToLoad = 0
let loadedStemsCount = 0

// Grid configuration
const defaultGridSize = 0 // Start with 0 cells, grow as stems are added
let gridSize = defaultGridSize
let gridCells: StemCell[] = []

// Callback for when cells are updated
let onCellsUpdate: ((activeCells: number[]) => void) | null = null
let onStemsLoadedCallback: ((stems: Stem[]) => void) | null = null

// Get array of active cell indices
function getActiveCells(): number[] {
  const activeCells: number[] = []
  for (let i = 0; i < gridCells.length; i++) {
    if (gridCells[i].isActive) {
      activeCells.push(i)
    }
  }
  return activeCells
}

// Get array of stems in active cells
function getActiveStems(): Stem[] {
  const activeStems: Stem[] = []
  for (let i = 0; i < gridCells.length; i++) {
    if (gridCells[i].isActive && gridCells[i].stem) {
      activeStems.push(gridCells[i].stem!)
    }
  }
  return activeStems
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
    audioScheduler.updateActiveStems(getActiveCells(), gridCells)
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
      if (index >= 0 && index < gridSize && !isNaN(index)) {
        const cell = gridCells[index]
        // Only require that cell has a stem (metadata loaded) - audio can still be loading
        if (cell && cell.stem) {
          cell.isActive = true
        }
      }
    })

    updateCellVisuals()
    // Don't trigger callback that updates URL during loading
    if (!isLoadingStems) {
      triggerCellsUpdateCallback()
    }
  }
}

// Directory picker functions
async function selectDirectory(): Promise<void> {
  console.log('selectDirectory function called')

  try {
    // Check if File System Access API is supported
    if (!('showDirectoryPicker' in window)) {
      console.error('File System Access API is not supported in this browser')
      return
    }

    console.log('About to call window.showDirectoryPicker()')

    // Show directory picker
    const handle = await (window as any).showDirectoryPicker()
    directoryHandle = handle

    // Save directory handle to IndexedDB
    await set(DIRECTORY_HANDLE_KEY, handle)

    console.log('Directory selected:', handle.name)

    // Initialize grid if not already done
    if (gridCells.length === 0) {
      initializeGrid()
      setupEventListeners()
      // Don't load URL state here - wait for stems to be loaded
    }

    // Don't show grid yet - wait for stems to be loaded
    // Grid will be shown when first stems are added

    // Trigger directory loaded callback
    if (onDirectoryLoaded) {
      await onDirectoryLoaded(handle)
    }
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') {
      console.error('Error selecting directory:', error)
    } else {
      console.log('Directory selection was cancelled by user')
    }
  }
}

async function loadSavedDirectory(): Promise<boolean> {
  try {
    const savedHandle = await get(DIRECTORY_HANDLE_KEY)

    if (savedHandle) {
      // Verify we still have permission to access the directory
      const permission = await savedHandle.queryPermission({ mode: 'readwrite' })

      if (permission === 'granted' || permission === 'prompt') {
        directoryHandle = savedHandle
        console.log('Loaded saved directory:', savedHandle.name)

        // Initialize grid if not already done
        if (gridCells.length === 0) {
          initializeGrid()
          setupEventListeners()
          // Don't load URL state here - wait for stems to be loaded
        }

        // Don't show grid yet - wait for stems to be loaded
        // Grid will be shown when first stems are added

        // Trigger directory loaded callback
        if (onDirectoryLoaded) {
          await onDirectoryLoaded(savedHandle)
        }

        return true
      }
    }
  } catch (error) {
    console.log('No saved directory or error loading:', error)
  }

  return false
}

async function findZipFiles(dirHandle: FileSystemDirectoryHandle) {
  const zipFiles = []
  for await (const [name, handle] of dirHandle.entries()) {
    if (
      handle.kind === 'file'
      && name.endsWith('.zip')
      && name.includes('[Stems]')
    ) {
      zipFiles.push({ name, handle })
    }
  }
  return zipFiles
}

async function readZipFileMetadata(dirHandle: FileSystemDirectoryHandle, fileName: string) {
  const fileHandle = await dirHandle.getFileHandle(fileName)
  const zipFile = await fileHandle.getFile()
  const arrayBuffer = await zipFile.arrayBuffer()

  const zip = new JSZip()
  const zipContent = await zip.loadAsync(arrayBuffer)

  // Extract metadata without decoding audio
  let stemMetadata: Array<{
    name: string
    bpm: number
    kind: StemKind
    fileName: string
    zipFile: JSZip.JSZipObject
  }> = []

  for (const file of Object.values(zipContent.files)) {
    if (file.dir) continue
    const name = file.name.split('/')[1].split(' - ').slice(2).join(' - ').replace('.wav', '')
    const bpm = Number(file.name.split('/')[1].split(' - ')[1].split(' ')[0])
    const kind = file.name.split('/')[1].split(' - ')[3] as StemKind

    stemMetadata.push({
      name,
      bpm,
      kind,
      fileName: file.name,
      zipFile: file
    })
  }

  return stemMetadata
}

async function decodeAudioForStem(audio: AudioContext, zipFile: JSZip.JSZipObject): Promise<AudioBuffer> {
  const arrayBuffer = await zipFile.async('arraybuffer')
  return await audio.decodeAudioData(arrayBuffer)
}

async function readZipFile(audio: AudioContext, dirHandle: FileSystemDirectoryHandle, fileName: string) {
  const fileHandle = await dirHandle.getFileHandle(fileName)
  const zipFile = await fileHandle.getFile()
  const arrayBuffer = await zipFile.arrayBuffer()

  const zip = new JSZip()
  const zipContent = await zip.loadAsync(arrayBuffer)

  // NOTE: The following code is brittle. We expect
  // certain patterns to be followed by the stems zip and its contents,
  // so any weird deviation will most likely break something here.
  let stems: Stem[] = []
  for (const file of Object.values(zipContent.files)) {
    if (file.dir) continue
    const name = file.name.split('/')[1].split(' - ').slice(2).join(' - ').replace('.wav', '')
    const bpm = Number(file.name.split('/')[1].split(' - ')[1].split(' ')[0])
    const kind = file.name.split('/')[1].split(' - ')[3] as StemKind

    const arrayBuffer = await file.async('arraybuffer')
    const buffer = await audio.decodeAudioData(arrayBuffer)

    const stem: Stem = {
      name,
      bpm,
      kind,
      buffer
    }

    stems.push(stem)
  }

  return stems
}

function showGrid(): void {
  const directoryPicker = document.getElementById('directoryPicker')
  const grid = document.getElementById('grid')

  if (directoryPicker) directoryPicker.style.display = 'none'
  if (grid) grid.style.display = 'grid'
}

function showDirectoryPicker(): void {
  const directoryPicker = document.getElementById('directoryPicker')
  const grid = document.getElementById('grid')

  if (directoryPicker) directoryPicker.style.display = 'flex'
  if (grid) grid.style.display = 'none'
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

function setupAudioButton(): void {
  const startBtn = document.getElementById('startAudioBtn')
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.textContent = '⏳ Starting...'
        ; (startBtn as HTMLButtonElement).disabled = true

      try {
        await audioScheduler.initializeAudio()
        audioScheduler.start()

        // Update with current active cells if any
        audioScheduler.updateActiveStems(getActiveCells(), gridCells)

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
      gridSize = parsedSize
    }
  }

  // Show audio overlay initially
  showAudioOverlay()
  setupAudioButton()

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

// Initialize grid cells
function initializeGrid(): void {
  // Start with empty grid, will grow as stems are added
  if (gridCells.length === 0) {
    gridCells = []
  }
}

// Add stems to available cells
function addStemsToGrid(stems: Stem[]): void {
  // Extend grid size to accommodate new stems
  const newTotalSize = gridCells.length + stems.length

  // Add new empty cells for the new stems
  for (let i = gridCells.length; i < newTotalSize; i++) {
    gridCells.push({
      stem: null,
      isActive: false,
      isLoading: false,
      element: null
    })
  }

  // Update grid size
  gridSize = newTotalSize

  // Add stems to the newly created cells
  for (let i = 0; i < stems.length; i++) {
    const cellIndex = newTotalSize - stems.length + i
    gridCells[cellIndex].stem = stems[i]
  }

  // Show grid and hide directory picker when first stems are added
  if (newTotalSize === stems.length) {
    // This is the first batch of stems
    const directoryPicker = document.getElementById('directoryPicker')
    if (directoryPicker) directoryPicker.style.display = 'none'
  }

  // Recreate the grid with new size
  createGrid()

  // Re-apply URL state after each batch of stems is loaded
  loadActiveCellsFromUrl()

  if (onStemsLoadedCallback) {
    onStemsLoadedCallback(stems)
  }
}

// Pre-allocate cells with loading state for smoother experience
function preallocateLoadingCells(estimatedCount: number): number[] {
  const startIndex = gridCells.length
  const newTotalSize = gridCells.length + estimatedCount

  // Add new loading cells
  for (let i = gridCells.length; i < newTotalSize; i++) {
    gridCells.push({
      stem: null,
      isActive: false,
      isLoading: true,
      element: null
    })
  }

  // Update grid size
  gridSize = newTotalSize

  // Show grid and hide directory picker when first cells are added
  if (startIndex === 0) {
    const directoryPicker = document.getElementById('directoryPicker')
    if (directoryPicker) directoryPicker.style.display = 'none'
  }

  // Recreate the grid with loading cells
  createGrid()

  // Return the indices of the pre-allocated cells
  const allocatedIndices = []
  for (let i = startIndex; i < newTotalSize; i++) {
    allocatedIndices.push(i)
  }
  return allocatedIndices
}

// Fill pre-allocated cells with actual stems
function fillPreallocatedCells(startIndex: number, stems: Stem[]): void {
  // Fill the cells with actual stems
  for (let i = 0; i < stems.length && startIndex + i < gridCells.length; i++) {
    const cellIndex = startIndex + i
    gridCells[cellIndex].stem = stems[i]
    gridCells[cellIndex].isLoading = false
    updateCellVisual(cellIndex)
  }

  // If we have fewer stems than expected, remove extra loading cells
  if (stems.length < gridCells.length - startIndex) {
    const excessCells = gridCells.length - startIndex - stems.length
    gridCells.splice(gridCells.length - excessCells, excessCells)
    gridSize = gridCells.length
    createGrid()
  }

  // Apply URL state after filling cells
  loadActiveCellsFromUrl()

  if (onStemsLoadedCallback) {
    onStemsLoadedCallback(stems)
  }
}

// Set loading state for cells
function setCellLoading(indices: number[], loading: boolean): void {
  indices.forEach(index => {
    if (index >= 0 && index < gridCells.length) {
      gridCells[index].isLoading = loading
      updateCellVisual(index)
    }
  })
}

// Generate consistent random colors for each cell
function generateColors(): void {
  // Colors are now handled by StemColors based on stem.kind
  // This function is kept for compatibility but not used
}

// Calculate optimal grid dimensions
function calculateGridDimensions(): { cols: number; rows: number } {
  const container = document.getElementById('grid') as HTMLElement
  const containerWidth = container.clientWidth - 32 // Account for padding
  const containerHeight = container.clientHeight - 32

  // Try to make cells as square as possible while fitting all items
  const aspectRatio = containerWidth / containerHeight
  const cellsRatio = Math.sqrt(gridSize * aspectRatio)

  let cols = Math.ceil(cellsRatio)
  let rows = Math.ceil(gridSize / cols)

  // Ensure we don't exceed grid size
  if (cols * rows < gridSize) {
    if (cols < rows) {
      cols++
    } else {
      rows++
    }
  }

  return { cols, rows }
}

// Create the grid
function createGrid(): void {
  const container = document.getElementById('grid') as HTMLElement
  if (!container) return

  // If no cells, hide the grid
  if (gridSize === 0) {
    container.style.display = 'none'
    return
  }

  // Show the grid
  container.style.display = 'grid'

  const { cols, rows } = calculateGridDimensions()

  // Set up CSS Grid
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
  container.style.gridTemplateRows = `repeat(${rows}, 1fr)`

  // Clear existing cells
  container.innerHTML = ''

  // Create cells
  for (let i = 0; i < gridSize; i++) {
    const cell = document.createElement('div')
    cell.className = 'grid-cell'
    cell.dataset.index = i.toString()

    // Add touch and click event listeners
    cell.addEventListener('click', () => toggleCell(i))
    cell.addEventListener('touchstart', (e) => {
      e.preventDefault()
      toggleCell(i)
    }, { passive: false })

    container.appendChild(cell)
    gridCells[i].element = cell
  }

  updateCellVisuals()
}

// Toggle cell state
function toggleCell(index: number): void {
  if (index < 0 || index >= gridSize) return

  // Only toggle if cell has a stem
  if (gridCells[index].stem) {
    gridCells[index].isActive = !gridCells[index].isActive
    updateCellVisual(index)
    triggerCellsUpdateCallback()
  }
}

// Update visual for a specific cell
function updateCellVisual(index: number): void {
  const cellData = gridCells[index]
  const cell = cellData.element
  if (!cell) return

  const { stem, isActive, isLoading } = cellData

  // Clear previous styles
  cell.classList.remove('active', 'loading')
  cell.style.backgroundColor = ''
  cell.style.boxShadow = ''
  cell.innerHTML = ''

  if (!stem) {
    // Empty cell
    cell.style.backgroundColor = 'rgba(128, 128, 128, 0.1)'
    return
  }

  // Get HSL color from StemColors [hue, saturation, lightness]
  const [hue, saturation, lightness] = StemColors[stem.kind] || [0, 0, 50]

  if (isActive) {
    // Show active state
    cell.classList.add('active')

    if (isLoading) {
      // Active but still loading - use grayscale (saturation 0)
      cell.style.backgroundColor = `hsl(${hue}, 15%, ${lightness}%)`
      cell.style.boxShadow = `0 0 25px hsl(${hue}, 15%, ${lightness}%, 0.6), 0 0 50px hsl(${hue}, 0%, ${lightness}%, 0.6)`
    } else {
      // Active and loaded - use full color
      cell.style.backgroundColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`
      cell.style.boxShadow = `0 0 25px hsl(${hue}, ${saturation}%, ${lightness}%, 0.6), 0 0 50px hsl(${hue}, ${saturation}%, ${lightness}%, 0.6)`
    }
  } else {
    // Inactive state
    if (isLoading) {
      // Loading but inactive - grayscale with low opacity
      cell.style.backgroundColor = `hsl(${hue}, 15%, ${lightness}%, 0.3)`
    } else {
      // Normal inactive state - dimmed color
      cell.style.backgroundColor = `hsl(${hue}, ${saturation}%, ${lightness}%, 0.25)`
    }
  }
}

// Update all cell visuals
function updateCellVisuals(): void {
  for (let i = 0; i < gridSize; i++) {
    updateCellVisual(i)
  }
}

// Setup event listeners
function setupEventListeners(): void {
  // Initialize audio on first user interaction
  let audioInitialized = false

  function initializeAudioOnFirstInteraction() {
    if (!audioInitialized) {
      audioInitialized = true
      audioScheduler.initializeAudio().then(() => {
        audioScheduler.start()
        // Update with current active cells
        audioScheduler.updateActiveStems(getActiveCells(), gridCells)
      })
    }
  }

  // Handle window resize
  let resizeTimeout: any
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout)
    resizeTimeout = setTimeout(() => {
      createGrid()
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
      updateCellVisuals()
      triggerCellsUpdateCallback()
    }

    if (e.key === 'a' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      // Activate all cells with stems
      gridCells.forEach(cell => {
        if (cell.stem) cell.isActive = true
      })
      updateCellVisuals()
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
  })
}

// Export functions for potential external use
function setGridCells(size: number): void {
  if (size > 0 && size <= 1024) {
    const previousSize = gridSize
    gridSize = size

    // Initialize new grid
    initializeGrid()
    createGrid()

    // If grid size changed, load from URL or trigger callback for empty state
    if (previousSize !== size) {
      loadActiveCellsFromUrl()
    } else {
      // Same size, just trigger callback to maintain URL sync
      triggerCellsUpdateCallback()
    }
  }
}

function resetGrid(): void {
  gridCells.forEach(cell => cell.isActive = false)
  updateCellVisuals()
  triggerCellsUpdateCallback()
}

function activateAll(): void {
  gridCells.forEach(cell => {
    if (cell.stem) cell.isActive = true
  })
  updateCellVisuals()
  triggerCellsUpdateCallback()
}

// Set callback for cell updates
function onCellsUpdated(callback: ((activeCells: number[]) => void) | null): void {
  onCellsUpdate = callback
}

// Set callback for when stems are loaded
function setOnStemsLoaded(callback: ((stems: Stem[]) => void) | null): void {
  onStemsLoadedCallback = callback
}

// Add stems without audio buffers (metadata only)
function addStemMetadataToGrid(stemMetadata: Array<{
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

  // Extend grid size to accommodate new stems
  const newTotalSize = gridCells.length + stemMetadata.length

  // Add new empty cells for the new stems
  for (let i = gridCells.length; i < newTotalSize; i++) {
    gridCells.push({
      stem: null,
      isActive: false,
      isLoading: true, // Show as loading while audio decodes
      element: null
    })
  }

  // Update grid size
  gridSize = newTotalSize

  // Add stem metadata to the newly created cells (without audio buffers)
  for (let i = 0; i < stemMetadata.length; i++) {
    const cellIndex = newTotalSize - stemMetadata.length + i
    const metadata = stemMetadata[i]

    // Create stem without audio buffer
    gridCells[cellIndex].stem = {
      name: metadata.name,
      bpm: metadata.bpm,
      kind: metadata.kind,
      buffer: null as any // Will be filled later
    }
    gridCells[cellIndex].isLoading = true
  }

  // Show grid and hide directory picker when first stems are added
  if (newTotalSize === stemMetadata.length) {
    // This is the first batch of stems
    const directoryPicker = document.getElementById('directoryPicker')
    if (directoryPicker) directoryPicker.style.display = 'none'
  }

  // Recreate the grid with new size
  createGrid()

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

// Update a specific cell with decoded audio buffer
function updateCellWithAudioBuffer(cellIndex: number, audioBuffer: AudioBuffer): void {
  if (cellIndex >= 0 && cellIndex < gridCells.length && gridCells[cellIndex].stem) {
    gridCells[cellIndex].stem!.buffer = audioBuffer
    gridCells[cellIndex].isLoading = false
    updateCellVisual(cellIndex)

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
}

// Audio Scheduler Class
class AudioScheduler {
  private audioContext: AudioContext | null = null
  private masterGainNode: GainNode | null = null
  private isPlaying = false
  private startTime = 0
  private activeSources: Map<number, {
    source: AudioBufferSourceNode
    gainNode: GainNode
    stem: Stem
  }> = new Map()
  private isInitialized = false
  private fadeTime = 0.005 // 5ms fade in/out - very quick to avoid clicks
  private masterBPM = 120 // Default BPM, will be updated from stems
  private beatsPerBar = 4 // 4/4 time signature
  private barDuration = 0 // Calculated from BPM

  async initializeAudio(): Promise<void> {
    if (this.isInitialized) return

    try {
      this.audioContext = new AudioContext()
      this.masterGainNode = this.audioContext.createGain()
      this.masterGainNode.connect(this.audioContext.destination)

      // Resume context if suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume()
      }

      this.updateBarDuration()
      this.isInitialized = true
      console.log('Audio scheduler initialized')
    } catch (error) {
      console.error('Failed to initialize audio:', error)
    }
  }

  private updateBarDuration(): void {
    // Calculate bar duration in seconds: (60 / BPM) * beatsPerBar
    this.barDuration = (60 / this.masterBPM) * this.beatsPerBar
    console.log(`Bar duration: ${this.barDuration.toFixed(2)}s at ${this.masterBPM} BPM`)
  }

  setMasterBPM(bpm: number): void {
    this.masterBPM = bpm
    this.updateBarDuration()
  }

  private getCurrentBarPosition(): number {
    if (!this.audioContext || !this.isPlaying) return 0

    const elapsed = this.audioContext.currentTime - this.startTime
    return elapsed % this.barDuration
  }

  private getTimeToNextBar(): number {
    const barPosition = this.getCurrentBarPosition()
    return this.barDuration - barPosition
  }

  private getNextBarStartTime(): number {
    if (!this.audioContext) return 0

    return this.audioContext.currentTime + this.getTimeToNextBar()
  }

  async resumeAudioContext(): Promise<void> {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume()
    }
  }

  start(): void {
    if (!this.audioContext || !this.masterGainNode) return

    this.isPlaying = true
    this.startTime = this.audioContext.currentTime
    console.log(`Scheduler started at ${this.masterBPM} BPM`)
  }

  stop(): void {
    this.isPlaying = false
    this.stopAllSources()
    console.log('Scheduler stopped')
  }

  private stopAllSources(): void {
    for (const [cellIndex, source] of this.activeSources) {
      this.stopSource(cellIndex, source)
    }
    this.activeSources.clear()
  }

  private stopSource(cellIndex: number, sourceInfo: { source: AudioBufferSourceNode, gainNode: GainNode }): void {
    if (!this.audioContext) return

    try {
      // Calculate when to stop based on bar alignment
      let stopTime: number
      if (this.isPlaying) {
        // Stop at the next bar boundary
        stopTime = this.getNextBarStartTime()
        const timeToNext = stopTime - this.audioContext.currentTime
        console.log(`Scheduling fade out in ${timeToNext.toFixed(2)}s at next bar`)
      } else {
        // Stop immediately if not playing
        stopTime = this.audioContext.currentTime
      }

      // Fade out at the scheduled stop time
      sourceInfo.gainNode.gain.setValueAtTime(sourceInfo.gainNode.gain.value, stopTime)
      sourceInfo.gainNode.gain.linearRampToValueAtTime(0, stopTime + this.fadeTime)

      // Stop source after fade
      sourceInfo.source.stop(stopTime + this.fadeTime)
    } catch (error) {
      // Source might already be stopped
      console.warn('Error stopping source:', error)
    }
  }

  addStem(cellIndex: number, stem: Stem): void {
    if (!this.audioContext || !this.masterGainNode || !stem.buffer) return

    // Update master BPM from first stem if not set manually
    if (this.masterBPM === 120 && stem.bpm) {
      this.setMasterBPM(stem.bpm)
    }

    // Remove existing source if any
    this.removeStem(cellIndex)

    try {
      // Create audio source
      const source = this.audioContext.createBufferSource()
      source.buffer = stem.buffer
      source.loop = true

      // Create gain node for individual stem volume and fading
      const gainNode = this.audioContext.createGain()
      gainNode.gain.setValueAtTime(0, this.audioContext.currentTime) // Start silent

      // Connect: source -> gainNode -> masterGain -> destination
      source.connect(gainNode)
      gainNode.connect(this.masterGainNode)

      // Store reference
      this.activeSources.set(cellIndex, { source, gainNode, stem })

      // Calculate when to start based on bar alignment
      let startTime: number
      if (this.isPlaying) {
        // Start at the next bar boundary
        startTime = this.getNextBarStartTime()
        const timeToNext = startTime - this.audioContext.currentTime
        console.log(`Scheduling "${stem.name}" to start in ${timeToNext.toFixed(2)}s at next bar`)
      } else {
        // Start immediately if not playing
        startTime = this.audioContext.currentTime
      }

      // Start playback
      source.start(startTime)

      // Fade in at the scheduled start time
      gainNode.gain.setValueAtTime(0, startTime)
      gainNode.gain.linearRampToValueAtTime(1, startTime + this.fadeTime)

      console.log(`Added stem: ${stem.name} (${stem.kind}) at ${stem.bpm} BPM`)
    } catch (error) {
      console.error('Error adding stem:', error)
    }
  }

  removeStem(cellIndex: number): void {
    const sourceInfo = this.activeSources.get(cellIndex)
    if (!sourceInfo) return

    this.stopSource(cellIndex, sourceInfo)
    this.activeSources.delete(cellIndex)

    console.log(`Removed stem: ${sourceInfo.stem.name}`)
  }

  updateActiveStems(activeCells: number[], allCells: StemCell[]): void {
    if (!this.isInitialized) return

    // Get currently playing stems
    const currentlyPlaying = new Set(this.activeSources.keys())
    const shouldBePlaying = new Set(activeCells.filter(index =>
      allCells[index] && allCells[index].stem && allCells[index].stem!.buffer
    ))

    // Stop stems that should no longer be playing
    for (const cellIndex of currentlyPlaying) {
      if (!shouldBePlaying.has(cellIndex)) {
        this.removeStem(cellIndex)
      }
    }

    // Start stems that should be playing
    for (const cellIndex of shouldBePlaying) {
      if (!currentlyPlaying.has(cellIndex)) {
        const stem = allCells[cellIndex].stem
        if (stem && stem.buffer) {
          this.addStem(cellIndex, stem)
        }
      }
    }
  }

  setMasterVolume(volume: number): void {
    if (this.masterGainNode) {
      this.masterGainNode.gain.setValueAtTime(volume, this.audioContext?.currentTime || 0)
    }
  }

  isAudioInitialized(): boolean {
    return this.isInitialized
  }

  // Get current musical position info
  getMusicalPosition(): { bar: number, beat: number, position: number } {
    if (!this.isPlaying) return { bar: 0, beat: 0, position: 0 }

    const elapsed = this.getCurrentBarPosition()
    const position = elapsed / this.barDuration
    const beat = Math.floor(position * this.beatsPerBar) + 1
    const totalBars = Math.floor((this.audioContext!.currentTime - this.startTime) / this.barDuration) + 1

    return { bar: totalBars, beat, position }
  }

  getMasterBPM(): number {
    return this.masterBPM
  }
}

// Create global scheduler instance
const audioScheduler = new AudioScheduler()

// Create the looper controller object
export const looper = {
  init,

  // Set the number of grid cells
  setGridCells: (size: number): void => {
    if (size > 0 && size <= 1024) {
      const previousSize = gridSize
      gridSize = size

      // Initialize new grid
      initializeGrid()
      createGrid()

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
    return gridSize
  },

  // Add stems to grid
  addStemsToGrid: (stems: Stem[]): void => {
    addStemsToGrid(stems)
  },

  // Pre-allocate loading cells
  preallocateLoadingCells: (estimatedCount: number): number[] => {
    return preallocateLoadingCells(estimatedCount)
  },

  // Fill pre-allocated cells with stems
  fillPreallocatedCells: (startIndex: number, stems: Stem[]): void => {
    fillPreallocatedCells(startIndex, stems)
  },

  // Set loading state for cells
  setCellLoading: (indices: number[], loading: boolean): void => {
    setCellLoading(indices, loading)
  },

  // Get grid cells
  getGridCells: (): StemCell[] => {
    return gridCells
  },

  // Add stems without audio buffers (metadata only)
  addStemMetadataToGrid: (stemMetadata: Array<{
    name: string
    bpm: number
    kind: StemKind
    fileName: string
    zipFile: any
  }>): void => {
    addStemMetadataToGrid(stemMetadata)
  },

  // Update a specific cell with decoded audio buffer
  updateCellWithAudioBuffer: (cellIndex: number, audioBuffer: AudioBuffer): void => {
    updateCellWithAudioBuffer(cellIndex, audioBuffer)
  },

  // Directory methods
  selectDirectory: (): Promise<void> => {
    return selectDirectory()
  },

  getDirectoryHandle: (): FileSystemDirectoryHandle | null => {
    return directoryHandle
  },

  onDirectoryLoaded: (callback: ((handle: FileSystemDirectoryHandle) => void | Promise<void>) | null): void => {
    onDirectoryLoaded = callback
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

  // Audio overlay management
  updateLoadingStatus,
}
