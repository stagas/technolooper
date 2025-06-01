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

// Control system state
interface ControlState {
  mode: 'initial' | 'cellSelection' | 'parameterControl'
  controlledCellIndex: number | null
  currentParameter: string | null
  isActive: boolean
}

let controlState: ControlState = {
  mode: 'initial',
  controlledCellIndex: null,
  currentParameter: null,
  isActive: false
}

// Parameter values for each cell
interface CellParameters {
  loopFraction: number // 1, 0.5, 0.25, 0.125, 0.0625 (full, 1/2, 1/4, 1/8, 1/16)
  volume: number // 0 to 1
  filter: number // -1 to 1 (negative = low-pass, positive = high-pass, 0 = no filter)
  delayWet: number // 0 to 1 (wet amount)
  delayTime: number // 0 to 1 (mapped exponentially to 0.1ms-2000ms)
  delayFeedback: number // 0 to 0.95 (feedback amount for worklet)
}

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
  params[parameter] = value

  // Update audio if this cell is currently playing
  if (audioScheduler.isAudioInitialized() && gridCells[cellIndex]?.isActive) {
    audioScheduler.updateCellParameter(cellIndex, parameter, value)
  }
}

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

  // Sort ZIP files alphabetically by name for consistent ordering
  zipFiles.sort((a, b) => a.name.localeCompare(b.name))

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

  // Sort stems within ZIP file for consistent ordering
  // Sort by: 1) BPM, 2) Kind, 3) Name
  stemMetadata.sort((a, b) => {
    if (a.bpm !== b.bpm) return a.bpm - b.bpm
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.name.localeCompare(b.name)
  })

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

  // Sort stems for consistent ordering
  // Sort by: 1) BPM, 2) Kind, 3) Name
  stems.sort((a, b) => {
    if (a.bpm !== b.bpm) return a.bpm - b.bpm
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.name.localeCompare(b.name)
  })

  return stems
}

// Show grid with control row
function showGrid(): void {
  const directoryPicker = document.getElementById('directoryPicker')
  const grid = document.getElementById('grid')
  const controlRow = document.getElementById('controlRow')

  if (directoryPicker) directoryPicker.style.display = 'none'
  if (grid) grid.style.display = 'grid'
  if (controlRow) controlRow.style.display = 'flex'
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
    const controlRow = document.getElementById('controlRow')
    if (controlRow) controlRow.style.display = 'none'
    return
  }

  // Show the grid and control row
  container.style.display = 'grid'
  const controlRow = document.getElementById('controlRow')
  if (controlRow) controlRow.style.display = 'flex'

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

  // Handle control mode
  if (controlState.isActive && controlState.mode === 'cellSelection') {
    // Select this cell for control
    if (gridCells[index].stem) {
      selectCellForControl(index)
    }
    return
  }

  // Normal toggle behavior
  if (gridCells[index].stem) {
    gridCells[index].isActive = !gridCells[index].isActive
    updateCellVisual(index)
    triggerCellsUpdateCallback()
  }
}

// Select a cell for control
function selectCellForControl(index: number): void {
  // Clear previous controlled cell
  if (controlState.controlledCellIndex !== null) {
    const prevCell = gridCells[controlState.controlledCellIndex]?.element
    if (prevCell) {
      prevCell.classList.remove('controlled')
    }
  }

  // Set new controlled cell
  controlState.controlledCellIndex = index
  const cell = gridCells[index].element
  if (cell) {
    cell.classList.add('controlled')
  }

  // Switch to cell selected controls
  showCellSelectedControls()

  console.log(`Cell ${index} selected for control: ${gridCells[index].stem?.name}`)
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
let eventListenersSetup = false
function setupEventListeners(): void {
  // Prevent multiple calls
  if (eventListenersSetup) {
    console.log('⚠️ setupEventListeners already called, skipping')
    return
  }
  eventListenersSetup = true
  console.log('🎧 Setting up event listeners')

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

  // Setup control row event listeners
  setupControlRowEventListeners()

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

  // Parameter slider
  const parameterSlider = document.getElementById('parameterSlider') as HTMLInputElement
  if (parameterSlider) {
    parameterSlider.addEventListener('input', (e) => {
      const value = parseFloat((e.target as HTMLInputElement).value)
      handleParameterChange(value)
    })
  }

  // Delay time slider
  const delayTimeSlider = document.getElementById('delayTimeSlider') as HTMLInputElement
  if (delayTimeSlider) {
    delayTimeSlider.addEventListener('input', (e) => {
      const value = parseFloat((e.target as HTMLInputElement).value)
      // When delayTimeSlider changes, it directly calls handleDelayTimeChange
      handleDelayTimeChange(value)
    })
  }

  // Delay Wet slider
  const delayWetSlider = document.getElementById('delayWetSlider') as HTMLInputElement
  if (delayWetSlider) {
    delayWetSlider.addEventListener('input', (e) => {
      const value = parseFloat((e.target as HTMLInputElement).value)
      // When delayWetSlider changes, it calls handleDelayWetChange
      handleDelayWetChange(value)
    })
  }

  // Delay Feedback slider
  const delayFeedbackSlider = document.getElementById('delayFeedbackSlider') as HTMLInputElement
  if (delayFeedbackSlider) {
    delayFeedbackSlider.addEventListener('input', (e) => {
      const value = parseFloat((e.target as HTMLInputElement).value)
      // When delayFeedbackSlider changes, it calls handleDelayFeedbackChange
      handleDelayFeedbackChange(value)
    })
  }
}

// Setup control row event listeners
function setupControlRowEventListeners(): void {
  // Control button
  const controlBtn = document.getElementById('controlBtn')
  if (controlBtn) {
    let clickCount = 0
    controlBtn.addEventListener('click', () => {
      clickCount++
      console.log(`🎛️ Control button clicked #${clickCount}. Current state: mode=${controlState.mode}, isActive=${controlState.isActive}`)
      console.log(`🔍 Button element:`, controlBtn)
      console.log(`🔍 Button classes:`, controlBtn.className)
      console.log(`🔍 Button disabled:`, (controlBtn as HTMLButtonElement).disabled)

      // Toggle control mode: if already in cell selection mode, turn it off
      if (controlState.mode === 'cellSelection' && controlState.isActive) {
        console.log(`🔄 Click #${clickCount}: Returning to initial state from cell selection`)
        returnToInitialControlState()
      } else {
        console.log(`🔄 Click #${clickCount}: Entering cell selection mode`)
        enterCellSelectionMode()
      }

      // Debug: Check button state after click with more details
      setTimeout(() => {
        const hasActive = controlBtn.classList.contains('active')
        const currentMode = controlState.mode
        const currentIsActive = controlState.isActive
        console.log(`🎛️ Click #${clickCount} result: hasActive=${hasActive}, mode=${currentMode}, isActive=${currentIsActive}`)
        console.log(`🔍 Button still exists:`, document.getElementById('controlBtn') === controlBtn)
        console.log(`🔍 Button parent:`, controlBtn.parentElement)
        console.log(`───────────────────────────────────────`)
      }, 10)
    })
  } else {
    console.error('❌ Control button not found during setup!')
  }

  // Return buttons
  const returnButtons = [
    document.getElementById('returnBtn'),
    document.getElementById('returnFromCellBtn'),
    document.getElementById('returnFromParamBtn')
  ]
  returnButtons.forEach(btn => {
    if (btn) {
      btn.addEventListener('click', () => {
        returnToInitialControlState()
      })
    }
  })

  // Parameter buttons
  const detuneBtn = document.getElementById('detuneBtn')
  if (detuneBtn) {
    detuneBtn.addEventListener('click', () => {
      enterParameterControl('loopFraction', 'Loop Length', '')
    })
  }

  const volumeBtn = document.getElementById('volumeBtn')
  if (volumeBtn) {
    volumeBtn.addEventListener('click', () => {
      enterParameterControl('volume', 'Volume', '%')
    })
  }

  const filterBtn = document.getElementById('filterBtn')
  if (filterBtn) {
    filterBtn.addEventListener('click', () => {
      enterParameterControl('filter', 'Filter', 'Hz')
    })
  }

  // Consolidated Delay button
  const delayBtn = document.getElementById('delayBtn')
  if (delayBtn) {
    delayBtn.addEventListener('click', () => {
      enterParameterControl('delay', 'Delay Settings', '') // New parameter type 'delay'
    })
  }

  // Parameter slider (generic)
  const parameterSlider = document.getElementById('parameterSlider') as HTMLInputElement
  if (parameterSlider) {
    parameterSlider.addEventListener('input', (e) => {
      const value = parseFloat((e.target as HTMLInputElement).value)
      handleParameterChange(value)
    })
  }

  // Removed duplicate delayTimeSlider setup - it's handled in setupControlRowEventListeners()
}

// Control state management functions
function enterCellSelectionMode(): void {
  console.log(`📥 enterCellSelectionMode() called`)
  console.log(`📊 State before: mode=${controlState.mode}, isActive=${controlState.isActive}`)

  // Ensure clean state transition
  controlState.mode = 'cellSelection'
  controlState.isActive = true
  controlState.controlledCellIndex = null
  controlState.currentParameter = null

  // Ensure initial controls are shown
  showInitialControls()

  // Update control button visual with more robust checking
  const controlBtn = document.getElementById('controlBtn')
  if (controlBtn) {
    // Debug: Check current classes before adding
    console.log('🔍 Control button classes before adding active:', controlBtn.className)
    console.log('🔍 Control button computed style before:', window.getComputedStyle(controlBtn).background)

    controlBtn.classList.add('active')

    console.log('🔍 Control button classes after adding active:', controlBtn.className)
    console.log('🔍 Control button computed style after:', window.getComputedStyle(controlBtn).background)
    console.log('✅ Control button activated - entering cell selection mode')

    // Force a style recalculation
    controlBtn.offsetHeight
  } else {
    console.error('❌ Control button not found when trying to activate')
  }

  console.log(`📊 State after: mode=${controlState.mode}, isActive=${controlState.isActive}`)
  console.log('Control mode: Select a cell to control')
}

function enterParameterControl(parameter: string, label: string, unit: string): void {
  if (controlState.controlledCellIndex === null) return

  controlState.mode = 'parameterControl'
  controlState.currentParameter = parameter // Set to 'delay' for the combined view

  // Hide cell selected controls, show parameter control
  const cellSelectedControls = document.getElementById('cellSelectedControls')
  const parameterControl = document.getElementById('parameterControl')

  if (cellSelectedControls) cellSelectedControls.style.display = 'none'
  if (parameterControl) parameterControl.style.display = 'flex'

  // Get references to all control groups
  const loopFractionControl = document.getElementById('loopFractionControl')
  const sliderControl = document.getElementById('sliderControl') // Generic slider
  const delaySettingsControl = document.getElementById('delaySettingsControl') // New container for delay

  // Hide all by default
  if (loopFractionControl) loopFractionControl.style.display = 'none'
  if (sliderControl) sliderControl.style.display = 'none'
  if (delaySettingsControl) delaySettingsControl.style.display = 'none'

  if (parameter === 'loopFraction') {
    if (loopFractionControl) loopFractionControl.style.display = 'flex'
    // ... (rest of loopFraction logic remains the same)
    // Set current loop fraction
    const cellParams = getCellParameters(controlState.controlledCellIndex)
    updateLoopFractionButtons(cellParams.loopFraction)

  } else if (parameter === 'delay') { // New case for combined delay controls
    if (delaySettingsControl) delaySettingsControl.style.display = 'flex'
    controlState.currentParameter = 'delay' // Keep top-level parameter as 'delay'

    const cellParams = getCellParameters(controlState.controlledCellIndex)

    // Setup Delay Wet
    const delayWetSlider = document.getElementById('delayWetSlider') as HTMLInputElement
    const delayWetParameterValue = document.getElementById('delayWetParameterValue')
    if (delayWetSlider && delayWetParameterValue) {
      const currentDelayWet = Math.round(cellParams.delayWet * 100)
      delayWetSlider.value = currentDelayWet.toString()
      delayWetParameterValue.textContent = `${currentDelayWet}%`
    }

    // Setup Delay Time (using existing updateDelayTimeControl)
    updateDelayTimeControl(cellParams.delayTime)

    // Setup Delay Feedback
    const delayFeedbackSlider = document.getElementById('delayFeedbackSlider') as HTMLInputElement
    const delayFeedbackParameterValue = document.getElementById('delayFeedbackParameterValue')
    if (delayFeedbackSlider && delayFeedbackParameterValue) {
      // Feedback is 0-0.95, slider is 0-95 for easier display
      const currentDelayFeedback = Math.round(cellParams.delayFeedback * 100)
      delayFeedbackSlider.value = currentDelayFeedback.toString()
      delayFeedbackParameterValue.textContent = `${currentDelayFeedback}%`
    }

  } else { // Generic slider case (volume, filter)
    if (sliderControl) sliderControl.style.display = 'flex'
    controlState.currentParameter = parameter // Set specific parameter for handleParameterChange

    const sliderParameterLabel = document.getElementById('sliderParameterLabel')
    if (sliderParameterLabel) sliderParameterLabel.textContent = label

    // Set slider range and current value based on parameter
    const parameterSlider = document.getElementById('parameterSlider') as HTMLInputElement
    const sliderParameterValue = document.getElementById('sliderParameterValue')

    if (parameterSlider && sliderParameterValue) {
      const cellParams = getCellParameters(controlState.controlledCellIndex)
      let currentValue = cellParams[parameter as keyof CellParameters]

      switch (parameter) {
        case 'volume':
          parameterSlider.min = '0'
          parameterSlider.max = '100'
          currentValue = Math.round(currentValue * 100)
          parameterSlider.value = currentValue.toString()
          sliderParameterValue.textContent = `${currentValue}${unit}`
          break
        case 'filter':
          parameterSlider.min = '-100'
          parameterSlider.max = '100'
          currentValue = Math.round(currentValue * 100)
          parameterSlider.value = currentValue.toString()

          // Update display based on filter type
          if (currentValue > 0) {
            sliderParameterValue.textContent = `High-pass ${currentValue}%`
          } else if (currentValue < 0) {
            sliderParameterValue.textContent = `Low-pass ${Math.abs(currentValue)}%`
          } else {
            sliderParameterValue.textContent = 'No Filter'
          }
          break
        case 'delayWet':
          parameterSlider.min = '0'
          parameterSlider.max = '100'
          currentValue = Math.round(currentValue * 100)
          parameterSlider.value = currentValue.toString()
          sliderParameterValue.textContent = `${currentValue}%`
          break
        case 'delayTime':
          parameterSlider.min = '0'
          parameterSlider.max = '100'
          currentValue = Math.round(currentValue * 100)
          parameterSlider.value = currentValue.toString()

          // Calculate actual delay time in ms for display
          const exponentialValue = Math.pow(currentValue / 100, 3) // This was for generic slider, direct delayTime doesn't go through here.
          const delayTimeMs = 0.1 + (exponentialValue * 1999.9)
          sliderParameterValue.textContent = `${delayTimeMs.toFixed(1)}ms`
          break
        case 'delayFeedback': // New case for feedback
          parameterSlider.min = '0'
          parameterSlider.max = '100'
          currentValue = Math.round(currentValue * 100)
          parameterSlider.value = currentValue.toString()
          sliderParameterValue.textContent = `${currentValue}%`
          break
      }
    }
  }

  console.log(`Control mode: Adjusting ${parameter} for cell ${controlState.controlledCellIndex}`)
}

function updateLoopFractionButtons(currentFraction: number): void {
  const fractionButtons = document.querySelectorAll('.rate-btn')
  const parameterValue = document.getElementById('parameterValue')

  // Update button states
  fractionButtons.forEach(btn => {
    const btnFraction = parseFloat(btn.getAttribute('data-fraction') || '1')
    if (Math.abs(btnFraction - currentFraction) < 0.0001) { // Use smaller epsilon for float comparison
      btn.classList.add('active')
    } else {
      btn.classList.remove('active')
    }
  })

  // Update display value
  if (parameterValue) {
    if (Math.abs(currentFraction - 0.001953125) < 0.0001) {
      parameterValue.textContent = '1/512'
    } else if (Math.abs(currentFraction - 0.00390625) < 0.0001) {
      parameterValue.textContent = '1/256'
    } else if (Math.abs(currentFraction - 0.0078125) < 0.0001) {
      parameterValue.textContent = '1/128'
    } else if (Math.abs(currentFraction - 0.015625) < 0.0001) {
      parameterValue.textContent = '1/64'
    } else if (Math.abs(currentFraction - 0.03125) < 0.0001) {
      parameterValue.textContent = '1/32'
    } else if (Math.abs(currentFraction - 0.0625) < 0.0001) {
      parameterValue.textContent = '1/16'
    } else if (Math.abs(currentFraction - 0.125) < 0.0001) {
      parameterValue.textContent = '1/8'
    } else if (Math.abs(currentFraction - 0.25) < 0.0001) {
      parameterValue.textContent = '1/4'
    } else if (Math.abs(currentFraction - 0.5) < 0.0001) {
      parameterValue.textContent = '1/2'
    } else if (Math.abs(currentFraction - 1) < 0.0001) {
      parameterValue.textContent = 'Full'
    } else {
      parameterValue.textContent = `${currentFraction.toFixed(6)}`
    }
  }
}

function updateDelayTimeControl(delayTime: number): void {
  const delayTimeSlider = document.getElementById('delayTimeSlider') as HTMLInputElement
  const delayParameterValue = document.getElementById('delayParameterValue')

  if (delayTimeSlider && delayParameterValue) {
    // Set slider value
    const displayValue = Math.round(delayTime * 100)
    delayTimeSlider.value = displayValue.toString()

    // Calculate actual delay time in ms for display
    const exponentialValue = Math.pow(delayTime, 3)
    const delayTimeMs = 0.1 + (exponentialValue * 1999.9)
    delayParameterValue.textContent = `${delayTimeMs.toFixed(1)}ms`
  }
}

function handleDelayTimeChange(sliderValue: number): void {
  if (controlState.controlledCellIndex === null) return

  // Convert slider value (0-100) to exponential delay time (0-1)
  // Use cubic curve for more precision at lower values
  const normalizedValue = sliderValue / 100 // 0-1
  const exponentialValue = Math.pow(normalizedValue, 3) // Exponential curve

  // Update parameter value
  setCellParameter(controlState.controlledCellIndex, 'delayTime', exponentialValue)

  // Calculate actual delay time in ms for display
  const delayTimeMs = 0.1 + (exponentialValue * 1999.9)

  // Update display
  const delayParameterValue = document.getElementById('delayParameterValue')
  if (delayParameterValue) {
    delayParameterValue.textContent = `${delayTimeMs.toFixed(1)}ms`
  }

  console.log(`🕐 Delay time: slider=${sliderValue}%, exponential=${exponentialValue.toFixed(3)}, ms=${delayTimeMs.toFixed(1)}`)
}

function handleDelayWetChange(sliderValue: number): void {
  if (controlState.controlledCellIndex === null) return

  const actualValue = sliderValue / 100 // Convert percentage to 0-1

  // Update parameter value
  setCellParameter(controlState.controlledCellIndex, 'delayWet', actualValue)

  // Update display for delayWetSlider
  const delayWetParameterValue = document.getElementById('delayWetParameterValue')
  if (delayWetParameterValue) {
    delayWetParameterValue.textContent = `${sliderValue}%`
  }
}

function handleDelayFeedbackChange(sliderValue: number): void {
  if (controlState.controlledCellIndex === null) return

  const actualValue = sliderValue / 100 // Convert percentage to 0-0.95 range (max feedback 0.95)
  // The worklet caps at 0.95, so slider 0-100 maps to 0-1, then capped by worklet
  // Or, for more precision at high values, map 0-100 to 0-0.95 directly:
  // const actualValue = (sliderValue / 100) * 0.95;

  // Update parameter value
  setCellParameter(controlState.controlledCellIndex, 'delayFeedback', actualValue)

  // Update display for delayFeedbackSlider
  const delayFeedbackParameterValue = document.getElementById('delayFeedbackParameterValue')
  if (delayFeedbackParameterValue) {
    delayFeedbackParameterValue.textContent = `${sliderValue}%`
  }
}

function handleParameterChange(sliderValue: number): void {
  if (controlState.controlledCellIndex === null || !controlState.currentParameter) return

  let actualValue = sliderValue
  let displayValue = sliderValue
  let displayText = ''
  let unit = ''

  // Convert slider value to actual parameter value
  switch (controlState.currentParameter) {
    case 'volume':
      actualValue = sliderValue / 100 // Convert percentage to 0-1
      displayValue = sliderValue
      unit = '%'
      displayText = `${displayValue}${unit}`
      break
    case 'filter':
      actualValue = sliderValue / 100 // Convert percentage to -1 to 1
      if (sliderValue > 0) {
        displayText = `High-pass ${sliderValue}%`
      } else if (sliderValue < 0) {
        displayText = `Low-pass ${Math.abs(sliderValue)}%`
      } else {
        displayText = 'No Filter'
      }
      break
    case 'delayWet':
      actualValue = sliderValue / 100 // Convert percentage to 0-1
      displayValue = sliderValue
      unit = '%'
      displayText = `${displayValue}${unit}`
      break
    case 'delayTime':
      actualValue = sliderValue / 100 // Convert percentage to 0-1

      // Calculate actual delay time in ms for display
      const exponentialValue = Math.pow(actualValue, 3)
      const delayTimeMs = 0.1 + (exponentialValue * 1999.9)
      displayText = `${delayTimeMs.toFixed(1)}ms`
      unit = ''
      break
    case 'delayFeedback': // New case for feedback
      actualValue = sliderValue / 100 // Convert percentage to 0-0.95 range (max feedback 0.95)
      displayValue = sliderValue
      unit = '%'
      displayText = `${displayValue}${unit}`
      break
  }

  // Update parameter value
  setCellParameter(
    controlState.controlledCellIndex,
    controlState.currentParameter as keyof CellParameters,
    actualValue
  )

  // Update display
  const sliderParameterValue = document.getElementById('sliderParameterValue')
  if (sliderParameterValue) {
    sliderParameterValue.textContent = displayText || `${displayValue}${unit}`
  }
}

function handleLoopFractionChange(fraction: number): void {
  if (controlState.controlledCellIndex === null) return

  // Update parameter value
  setCellParameter(controlState.controlledCellIndex, 'loopFraction', fraction)

  // Update button states and display
  updateLoopFractionButtons(fraction)

  console.log(`🔄 Loop fraction set to ${fraction} for cell ${controlState.controlledCellIndex}`)
}

function handleBPMDelaySync(fraction: number): void {
  if (controlState.controlledCellIndex === null) return

  // Get the stem's BPM for this cell
  const cell = gridCells[controlState.controlledCellIndex]
  if (!cell?.stem) return

  const stemBPM = cell.stem.bpm

  // Calculate BPM-synced delay time directly (copied from AudioScheduler.calculateBPMDelayTime)
  // Calculate the duration of the fraction in seconds
  const beatDuration = 60 / stemBPM // Duration of one beat in seconds
  const noteDuration = beatDuration * fraction // Duration of the note fraction

  // Map to the delay time range (0.1ms to 2000ms)
  const minDelayMs = 0.1
  const maxDelayMs = 2000
  const delayTimeMs = Math.min(Math.max(noteDuration * 1000, minDelayMs), maxDelayMs)

  // Convert to 0-1 range using inverse exponential mapping
  // Since we use exponential mapping: ms = 0.1 + (value^3 * 1999.9)
  // Solve for value: value = ((ms - 0.1) / 1999.9)^(1/3)
  const normalizedMs = (delayTimeMs - 0.1) / 1999.9
  const delayTimeValue = Math.pow(normalizedMs, 1 / 3)

  // Update parameter value
  setCellParameter(controlState.controlledCellIndex, 'delayTime', delayTimeValue)

  // Update the specific delay time slider (not the generic parameter slider)
  const delayTimeSlider = document.getElementById('delayTimeSlider') as HTMLInputElement
  const delayParameterValue = document.getElementById('delayParameterValue')

  if (delayTimeSlider && delayParameterValue) {
    // Convert to slider position (0-100)
    const sliderValue = delayTimeValue * 100
    delayTimeSlider.value = Math.round(sliderValue).toString()

    // Show the note fraction and ms
    const fractionNames: { [key: number]: string } = {
      0.0078125: '1/128',
      0.015625: '1/64',
      0.03125: '1/32',
      0.0625: '1/16',
      0.125: '1/8',
      0.16666666666: '1/6',
      0.25: '1/4',
      0.33333333333: '1/3',
      0.5: '1/2'
    }
    const fractionName = fractionNames[fraction] || `${fraction}`
    delayParameterValue.textContent = `${fractionName} (${delayTimeMs.toFixed(1)}ms)`
  }

  console.log(`🎵 BPM delay sync: ${fraction} note = ${delayTimeValue.toFixed(3)} (${delayTimeMs.toFixed(1)}ms) for cell ${controlState.controlledCellIndex}`)
}

function returnToInitialControlState(): void {
  console.log(`📤 returnToInitialControlState() called`)
  console.log(`📊 State before: mode=${controlState.mode}, isActive=${controlState.isActive}`)

  // Clear controlled cell visual
  if (controlState.controlledCellIndex !== null) {
    const cell = gridCells[controlState.controlledCellIndex]?.element
    if (cell) {
      cell.classList.remove('controlled')
    }
  }

  // Reset state
  controlState.mode = 'initial'
  controlState.controlledCellIndex = null
  controlState.currentParameter = null
  controlState.isActive = false

  // Reset control row visuals
  showInitialControls()

  // Remove active state from control button with more robust checking
  const controlBtn = document.getElementById('controlBtn')
  if (controlBtn) {
    // Debug: Check current classes before removing
    console.log('🔍 Control button classes before removing active:', controlBtn.className)
    console.log('🔍 Control button computed style before:', window.getComputedStyle(controlBtn).background)

    controlBtn.classList.remove('active')

    console.log('🔍 Control button classes after removing active:', controlBtn.className)
    console.log('🔍 Control button computed style after:', window.getComputedStyle(controlBtn).background)
    console.log('✅ Control button deactivated - returning to initial state')

    // Force a style recalculation
    controlBtn.offsetHeight
  } else {
    console.error('❌ Control button not found when trying to deactivate')
  }

  console.log(`📊 State after: mode=${controlState.mode}, isActive=${controlState.isActive}`)
  console.log('Control mode: Reset to initial state')
}

function showInitialControls(): void {
  const initialControls = document.getElementById('initialControls')
  const cellSelectedControls = document.getElementById('cellSelectedControls')
  const parameterControl = document.getElementById('parameterControl')

  if (initialControls) initialControls.style.display = 'flex'
  if (cellSelectedControls) cellSelectedControls.style.display = 'none'
  if (parameterControl) parameterControl.style.display = 'none'
}

function showCellSelectedControls(): void {
  const initialControls = document.getElementById('initialControls')
  const cellSelectedControls = document.getElementById('cellSelectedControls')
  const parameterControl = document.getElementById('parameterControl')

  if (initialControls) initialControls.style.display = 'none'
  if (cellSelectedControls) cellSelectedControls.style.display = 'flex'
  if (parameterControl) parameterControl.style.display = 'none'
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
    filterNode: BiquadFilterNode
    delayWorkletNode: AudioWorkletNode // Changed from DelayNode
    // delayFeedbackNode: GainNode // No longer needed, feedback handled by worklet
    delayWetNode: GainNode
    delayDryNode: GainNode
    stem: Stem
    currentLoopFraction: number
  }> = new Map()
  private isInitialized = false
  private isWorkletReady = false // Flag for worklet loading
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

      // Load the AudioWorklet module
      try {
        console.log('Attempting to load AudioWorklet module: variable-delay-processor.js')
        await this.audioContext.audioWorklet.addModule('variable-delay-processor.js')
        this.isWorkletReady = true
        console.log('✅ AudioWorklet module variable-delay-processor.js loaded successfully.')
      } catch (e) {
        console.error('❌ Error loading AudioWorklet module variable-delay-processor.js:', e)
        this.isWorkletReady = false
        // Potentially fall back to standard DelayNode or disable delay if critical
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

  private stopSource(cellIndex: number, sourceInfo: { source: AudioBufferSourceNode, gainNode: GainNode, filterNode: BiquadFilterNode }): void {
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
    if (!this.audioContext || !this.masterGainNode || !stem.buffer || !this.isWorkletReady) {
      if (!this.isWorkletReady) {
        console.warn('Delay Worklet not ready, cannot add stem with delay.')
      }
      return
    }

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

      // Create filter node for frequency filtering
      const filterNode = this.audioContext.createBiquadFilter()
      filterNode.type = 'allpass' // Start with no filtering
      filterNode.frequency.setValueAtTime(1000, this.audioContext.currentTime) // Default frequency

      // Create AudioWorkletNode for delay
      const delayWorkletNode = new AudioWorkletNode(this.audioContext, 'variable-delay-processor')
      // delayWorkletNode.parameters.get('delayTime')!.setValueAtTime(0, this.audioContext.currentTime); // Initial delay time
      // delayWorkletNode.parameters.get('feedback')!.setValueAtTime(0.3, this.audioContext.currentTime); // Initial feedback

      // Create wet/dry mix nodes
      const delayWetNode = this.audioContext.createGain()
      const delayDryNode = this.audioContext.createGain()
      delayWetNode.gain.setValueAtTime(0, this.audioContext.currentTime) // Start with no wet signal
      delayDryNode.gain.setValueAtTime(1, this.audioContext.currentTime) // Full dry signal

      // Connect delay chain:
      // filterNode -> delayDryNode (dry path) -> gainNode
      // filterNode -> delayWorkletNode (WET signal from worklet) -> delayWetNode -> gainNode

      filterNode.connect(delayDryNode)
      filterNode.connect(delayWorkletNode) // Input to worklet
      delayWorkletNode.connect(delayWetNode) // Output from worklet (wet signal)

      // Mix wet and dry signals into gain node
      delayDryNode.connect(gainNode)
      delayWetNode.connect(gainNode)

      // Connect: source -> filterNode -> delay(wet+dry) -> gainNode -> masterGain -> destination
      source.connect(filterNode)
      gainNode.connect(this.masterGainNode)

      // Store reference
      this.activeSources.set(cellIndex, {
        source,
        gainNode,
        filterNode,
        delayWorkletNode, // Store worklet node
        // delayFeedbackNode, // Removed
        delayWetNode,
        delayDryNode,
        stem,
        currentLoopFraction: 1
      })

      // Apply cell parameters
      const params = getCellParameters(cellIndex)
      this.applyCellParameters(cellIndex, params)

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
      gainNode.gain.linearRampToValueAtTime(params.volume, startTime + this.fadeTime)

      console.log(`Added stem: ${stem.name} (${stem.kind}) at ${stem.bpm} BPM`)
    } catch (error) {
      console.error('Error adding stem:', error)
    }
  }

  private applyCellParameters(cellIndex: number, params: CellParameters): void {
    const sourceInfo = this.activeSources.get(cellIndex)
    if (!sourceInfo || !this.audioContext) return

    // Apply loop fraction by setting loop start and end points
    if (sourceInfo.source.buffer && params.loopFraction < 1) {
      const bufferDuration = sourceInfo.source.buffer.duration
      const loopEnd = bufferDuration * params.loopFraction

      sourceInfo.source.loopStart = 0
      sourceInfo.source.loopEnd = loopEnd
      sourceInfo.currentLoopFraction = params.loopFraction

      console.log(`🔄 Set loop end to ${loopEnd.toFixed(3)}s (${params.loopFraction * 100}% of ${bufferDuration.toFixed(3)}s)`)
    } else {
      // Full loop
      sourceInfo.source.loopStart = 0
      sourceInfo.source.loopEnd = sourceInfo.source.buffer?.duration || 0
      sourceInfo.currentLoopFraction = 1
    }

    // Always apply volume regardless of current value
    sourceInfo.gainNode.gain.setValueAtTime(params.volume, this.audioContext.currentTime)

    // Apply filter settings
    this.applyFilterParameter(sourceInfo.filterNode, params.filter)

    // Apply delay settings
    this.applyDelayParameters(sourceInfo, params.delayWet, params.delayTime, params.delayFeedback, sourceInfo.stem.bpm)
  }

  private applyFilterParameter(filterNode: BiquadFilterNode, filterValue: number): void {
    if (!this.audioContext) return

    if (filterValue === 0) {
      // No filter - use allpass which doesn't affect the signal
      filterNode.type = 'allpass'
    } else if (filterValue > 0) {
      // High-pass filter for positive values
      filterNode.type = 'highpass'
      // Very exponential mapping with squared exponent for ultra-fine control at low values
      // 0-1 maps to 20Hz-8000Hz with steep exponential curve
      const exponentialValue = Math.pow(filterValue, 1) // Square the input for steeper curve
      const frequency = 20 * Math.pow(8000 / 20, exponentialValue)
      filterNode.frequency.setValueAtTime(frequency, this.audioContext.currentTime)
      filterNode.Q.setValueAtTime(3, this.audioContext.currentTime) // Higher resonance for more character
    } else {
      // Low-pass filter for negative values
      filterNode.type = 'lowpass'
      // Very exponential mapping with squared exponent for ultra-fine control at high values
      const absValue = Math.abs(filterValue)
      const exponentialValue = Math.pow(absValue, 3.5) // Square the input for steeper curve
      const frequency = 8000 * Math.pow(20 / 8000, exponentialValue)
      filterNode.frequency.setValueAtTime(frequency, this.audioContext.currentTime)
      filterNode.Q.setValueAtTime(3, this.audioContext.currentTime) // Higher resonance for more character
    }
  }

  private applyDelayParameters(sourceInfo: any, wetAmount: number, delayTime: number, feedbackAmount: number, stemBPM: number): void {
    if (!this.audioContext || !sourceInfo.delayWorkletNode) return

    // Calculate delay time in seconds with exponential mapping
    // 0-1 maps to 0.1ms-2000ms exponentially for flanger to long delay
    const exponentialValue = Math.pow(delayTime, 3) // Cubic curve for more room at small values
    const delayTimeMs = 0.1 + (exponentialValue * 1999.9) // 0.1ms to 2000ms
    const delayTimeSeconds = delayTimeMs / 1000

    // Apply delay time to the worklet
    const workletDelayTimeParam = sourceInfo.delayWorkletNode.parameters.get('delayTime')
    if (workletDelayTimeParam) {
      workletDelayTimeParam.setValueAtTime(delayTimeSeconds, this.audioContext.currentTime)
    }

    // Apply feedback to the worklet
    const workletFeedbackParam = sourceInfo.delayWorkletNode.parameters.get('feedback')
    if (workletFeedbackParam) {
      // feedbackAmount is 0-1 from slider, worklet expects 0-0.95
      workletFeedbackParam.setValueAtTime(Math.min(0.95, feedbackAmount), this.audioContext.currentTime)
    }

    // Apply wet/dry mix (Dry is always 100%, Wet controls the amount of delayed signal)
    sourceInfo.delayWetNode.gain.setValueAtTime(wetAmount, this.audioContext.currentTime)
    sourceInfo.delayDryNode.gain.setValueAtTime(1, this.audioContext.currentTime)

    console.log(`🔄 AW Delay: ${delayTimeMs.toFixed(1)}ms, Wet: ${(wetAmount * 100).toFixed(0)}%, Dry: 100%, Feedback: ${(Math.min(0.95, feedbackAmount) * 100).toFixed(0)}%`)
  }

  // Calculate BPM-synced delay time
  calculateBPMDelayTime(fraction: number, bpm: number): number {
    // Calculate note duration in milliseconds
    const beatDuration = (60 / bpm) * 1000 // One beat in ms
    const noteDuration = beatDuration * fraction // Fraction of a beat

    // Convert to 0-1 range for our exponential mapping
    // Reverse the exponential mapping: delayTime = (ms - 0.1) / 1999.9, then cube root
    const normalizedMs = Math.max(0, Math.min(1999.9, noteDuration - 0.1)) / 1999.9
    const delayTimeValue = Math.pow(normalizedMs, 1 / 3) // Inverse of cubic curve

    return Math.max(0, Math.min(1, delayTimeValue))
  }

  updateCellParameter(cellIndex: number, parameter: keyof CellParameters, value: number): void {
    const sourceInfo = this.activeSources.get(cellIndex)
    if (!sourceInfo || !this.audioContext) return

    switch (parameter) {
      case 'loopFraction':
        // For loop changes, we need to restart the source on the next beat
        if (this.isPlaying && sourceInfo.currentLoopFraction !== value) {
          this.scheduleLoopFractionChange(cellIndex, value)
        } else if (!this.isPlaying) {
          // If not playing, apply immediately
          this.applyLoopFractionChange(cellIndex, value)
        }
        break
      case 'volume':
        // Schedule volume changes at the next beat boundary for sync
        const changeTime = this.isPlaying ? this.getNextBeatTime() : this.audioContext.currentTime
        // Always update volume regardless of current value
        sourceInfo.gainNode.gain.setValueAtTime(value, changeTime)
        break
      case 'filter':
        // Apply filter changes immediately
        this.applyFilterParameter(sourceInfo.filterNode, value)
        console.log(`🎛️ Filter applied: ${value > 0 ? 'High-pass' : value < 0 ? 'Low-pass' : 'No filter'} for cell ${cellIndex}`)
        break
      case 'delayWet':
        // Apply delay wet amount immediately
        const params = getCellParameters(cellIndex)
        this.applyDelayParameters(sourceInfo, value, params.delayTime, params.delayFeedback, sourceInfo.stem.bpm)
        break
      case 'delayTime':
        // Apply delay time immediately
        const currentParams = getCellParameters(cellIndex)
        this.applyDelayParameters(sourceInfo, currentParams.delayWet, value, currentParams.delayFeedback, sourceInfo.stem.bpm)
        break
      case 'delayFeedback': // New case for feedback
        // Apply delay feedback amount immediately
        const fbParams = getCellParameters(cellIndex)
        this.applyDelayParameters(sourceInfo, fbParams.delayWet, fbParams.delayTime, value, sourceInfo.stem.bpm)
        break
    }
  }

  private getNextBeatTime(): number {
    if (!this.audioContext || !this.isPlaying) return this.audioContext?.currentTime || 0

    const elapsed = this.audioContext.currentTime - this.startTime
    const beatDuration = (60 / this.masterBPM) // One beat duration in seconds
    const currentBeat = Math.floor(elapsed / beatDuration)
    const nextBeatTime = this.startTime + (currentBeat + 1) * beatDuration

    return nextBeatTime
  }

  private scheduleLoopFractionChange(cellIndex: number, newFraction: number): void {
    if (!this.audioContext) return

    const nextBeatTime = this.getNextBeatTime()
    const timeToNextBeat = nextBeatTime - this.audioContext.currentTime

    console.log(`🎵 Scheduling loop fraction change to ${newFraction} in ${timeToNextBeat.toFixed(3)}s at next beat`)

    // Schedule the change
    setTimeout(() => {
      this.applyLoopFractionChange(cellIndex, newFraction)
    }, timeToNextBeat * 1000) // Convert to milliseconds
  }

  private applyLoopFractionChange(cellIndex: number, newFraction: number): void {
    const sourceInfo = this.activeSources.get(cellIndex)
    if (!sourceInfo || !this.audioContext) return

    const stem = sourceInfo.stem
    // Check if cell is active based on grid state, not gain value
    const cellData = gridCells[cellIndex]
    const isCurrentlyActive = cellData && cellData.isActive

    if (isCurrentlyActive) {
      // Stop the current source
      this.removeStem(cellIndex)

      // Update the stored parameter
      setCellParameter(cellIndex, 'loopFraction', newFraction)

      // Restart with new loop fraction
      this.addStem(cellIndex, stem)
    } else {
      // Just update the parameter if not playing
      setCellParameter(cellIndex, 'loopFraction', newFraction)
    }

    console.log(`✅ Applied loop fraction change to ${newFraction} for cell ${cellIndex}`)
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

  // Control system
  enterCellSelectionMode: (): void => {
    enterCellSelectionMode()
  },

  returnToInitialControlState: (): void => {
    returnToInitialControlState()
  },

  getControlState: (): ControlState => {
    return { ...controlState }
  },

  setCellParameter: (cellIndex: number, parameter: keyof CellParameters, value: number): void => {
    setCellParameter(cellIndex, parameter, value)
  },

  getCellParameters: (cellIndex: number): CellParameters => {
    return getCellParameters(cellIndex)
  },

  // Audio overlay management
  updateLoadingStatus,
}
