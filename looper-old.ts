// Import idb-keyval for directory handle persistence
import { get, set } from 'idb-keyval'
import JSZip from 'jszip'
import { Delay } from './delay-node.ts'

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
  mode: 'initial' | 'cellSelection' | 'parameterControl' | 'masterEffects'
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

// Master effect parameters
interface MasterEffectParameters {
  filter: number // -1 to 1 (negative = low-pass, positive = high-pass, 0 = no filter)
  delayWet: number // 0 to 1 (wet amount)
  delayTime: number // 0 to 1 (mapped exponentially to 0.1ms-2000ms)
  delayFeedback: number // 0 to 0.95 (feedback amount for worklet)
}

let masterEffectParameters: MasterEffectParameters = {
  filter: 0, // No filter by default
  delayWet: 0,
  delayTime: 0,
  delayFeedback: 0.3 // Default feedback
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
        audioScheduler.addStem(cellIndex, stem)
      }
    }

    else {
      audioScheduler.updateCellParameter(cellIndex, parameter, value)
    }
  }

  // Update visuals to show new pool assignments
  updateCellVisual(cellIndex)

  // Update controls availability when pool state changes
  if (parameter === 'delayWet' || parameter === 'filter') {
    updateControlsAvailability()
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
    audioScheduler.updateActiveStems(getActiveCells(), gridCells).catch(error => {
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
        await audioScheduler.updateActiveStems(getActiveCells(), gridCells)

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

  // Create content container
  const contentDiv = document.createElement('div')
  contentDiv.style.cssText = `
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    width: 100%;
    padding: 4px;
    box-sizing: border-box;
  `

  // Add pool indicators if active
  if (isActive) {
    const params = getCellParameters(index)
    const indicators: string[] = []

    // Check for active delay
    if (params.delayWet > 0) {
      const delayIndex = nodePool.getDelayNodeIndex(index)
      if (delayIndex > 0) {
        indicators.push(`D${delayIndex}`)
      }
    }

    // Check for active filter
    if (params.filter !== 0) {
      const filterIndex = nodePool.getFilterNodeIndex(index)
      if (filterIndex > 0) {
        indicators.push(`F${filterIndex}`)
      }
    }

    // Check for non-default loop fraction
    if (params.loopFraction < 1) {
      if (params.loopFraction === 0.5) {
        indicators.push('L½')
      } else if (params.loopFraction === 0.25) {
        indicators.push('L¼')
      } else if (params.loopFraction === 0.125) {
        indicators.push('L⅛')
      } else if (params.loopFraction === 0.0625) {
        indicators.push('L1/16')
      } else {
        indicators.push('L*')
      }
    }

    // Check for non-default volume
    if (Math.abs(params.volume - 1) > 0.01) {
      const volumePercent = Math.round(params.volume * 100)
      indicators.push(`V${volumePercent}`)
    }

    if (indicators.length > 0) {
      const indicatorDiv = document.createElement('div')
      indicatorDiv.textContent = indicators.join(' ')
      indicatorDiv.style.cssText = `
        font-size: 0.5rem;
        font-weight: bold;
        text-align: center;
        color: white;
        background: rgba(0, 0, 0, 0.3);
        padding: 1px 4px;
        border-radius: 2px;
        margin-top: 2px;
      `
      contentDiv.appendChild(indicatorDiv)
    }
  }

  cell.appendChild(contentDiv)

  if (isActive) {
    // Show active state
    cell.classList.add('active')

    if (isLoading) {
      // Active but still loading - use grayscale (saturation 0)
      cell.style.backgroundColor = `hsl(${hue}, 15%, ${lightness}%)`
      cell.style.boxShadow = `0 0 25px hsl(${hue}, 15%, ${lightness}%, 0.6), 0 0 50px hsl(${hue}, 0%, ${lightness}%, 0.6)`
    }

    else {
      // Active and loaded - use full color
      cell.style.backgroundColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`
      cell.style.boxShadow = `0 0 25px hsl(${hue}, ${saturation}%, ${lightness}%, 0.6), 0 0 50px hsl(${hue}, ${saturation}%, ${lightness}%, 0.6)`
    }
  }

  else {
    // Inactive state - but still show indicators for modified parameters
    const params = getCellParameters(index)
    const indicators: string[] = []

    // Check for non-default parameters on inactive cells
    if (params.loopFraction < 1) {
      if (params.loopFraction === 0.5) {
        indicators.push('L½')
      } else if (params.loopFraction === 0.25) {
        indicators.push('L¼')
      } else if (params.loopFraction === 0.125) {
        indicators.push('L⅛')
      } else if (params.loopFraction === 0.0625) {
        indicators.push('L1/16')
      } else {
        indicators.push('L*')
      }
    }

    if (Math.abs(params.volume - 1) > 0.01) {
      const volumePercent = Math.round(params.volume * 100)
      indicators.push(`V${volumePercent}`)
    }

    if (params.filter !== 0) {
      indicators.push('F*')
    }

    if (params.delayWet > 0) {
      indicators.push('D*')
    }

    if (indicators.length > 0) {
      const indicatorDiv = document.createElement('div')
      indicatorDiv.textContent = indicators.join(' ')
      indicatorDiv.style.cssText = `
        font-size: 0.45rem;
        font-weight: bold;
        text-align: center;
        color: #aaa;
        background: rgba(0, 0, 0, 0.5);
        padding: 1px 3px;
        border-radius: 2px;
        margin-top: 2px;
        opacity: 0.8;
      `
      contentDiv.appendChild(indicatorDiv)
    }

    if (isLoading) {
      // Loading but inactive - grayscale with low opacity
      cell.style.backgroundColor = `hsl(${hue}, 15%, ${lightness}%, 0.3)`
    }

    else {
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

  async function initializeAudioOnFirstInteraction(): Promise<void> {
    if (!audioInitialized) {
      audioInitialized = true
      try {
        await audioScheduler.initializeAudio()
        audioScheduler.start()
        // Update with current active cells
        await audioScheduler.updateActiveStems(getActiveCells(), gridCells)
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

  // Delay navigation buttons
  const delayNavPrev = document.getElementById('delayNavPrev')
  if (delayNavPrev) {
    delayNavPrev.addEventListener('click', () => {
      navigateDelayPreset('prev')
    })
  }

  const delayNavNext = document.getElementById('delayNavNext')
  if (delayNavNext) {
    delayNavNext.addEventListener('click', () => {
      navigateDelayPreset('next')
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
      }

      else {
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
  }

  else {
    console.error('❌ Control button not found during setup!')
  }

  // Reset All button
  const resetAllBtn = document.getElementById('resetAllBtn')
  if (resetAllBtn) {
    resetAllBtn.addEventListener('click', () => {
      console.log('🔄 Reset All button clicked')

      // Track cells that need to be restarted
      const cellsToRestart: number[] = []

      // Reset all cell parameters to defaults
      cellParameters.forEach((params, cellIndex) => {
        let needsRestart = false

        // Check if cell has any non-default parameters
        if (params.delayWet > 0 || params.filter !== 0 ||
          params.loopFraction !== 1 || Math.abs(params.volume - 1) > 0.01) {
          cellsToRestart.push(cellIndex)
          needsRestart = true
        }

        // Reset all parameters to defaults
        params.loopFraction = 1
        params.volume = 1
        params.filter = 0
        params.delayWet = 0
        params.delayTime = 0
        params.delayFeedback = 0.3
      })

      // Reset master effect parameters to defaults
      masterEffectParameters.filter = 0
      masterEffectParameters.delayWet = 0
      masterEffectParameters.delayTime = 0
      masterEffectParameters.delayFeedback = 0.3

      // Apply master effect resets to audio if initialized
      if (audioScheduler.isAudioInitialized()) {
        audioScheduler.updateMasterFilterParameter(0)
        audioScheduler.updateMasterDelayParameters(0, 0, 0.3)
      }

      // Release all pooled nodes
      nodePool.releaseAllNodes()

      // Restart affected stems that are currently active to apply new parameters
      cellsToRestart.forEach(cellIndex => {
        const cell = gridCells[cellIndex]
        if (cell && cell.isActive && cell.stem && audioScheduler.isAudioInitialized()) {
          // Remove and re-add the stem to apply reset parameters
          audioScheduler.removeStem(cellIndex)
          audioScheduler.addStem(cellIndex, cell.stem)
        }
      })

      // Update all cell visuals to remove indicators
      updateCellVisuals()

      // Update controls availability
      updateControlsAvailability()

      console.log(`✅ All parameters reset for ${cellsToRestart.length} cells`)
    })
  }

  // Effect button (for master effects)
  const effectBtn = document.getElementById('effectBtn')
  if (effectBtn) {
    effectBtn.addEventListener('click', () => {
      console.log('🎛️ Effect button clicked')
      enterMasterEffectsMode()
    })
  }

  // Return buttons
  const returnButtons = [
    document.getElementById('returnBtn'),
    document.getElementById('returnFromCellBtn'),
    document.getElementById('returnFromParamBtn'),
    document.getElementById('returnFromMasterBtn')
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
      if (nodePool.getAvailableFilterCount() > 0) {
        enterParameterControl('filter', 'Filter', 'Hz')
      }

      else {
        console.warn('No filter nodes available')
        // Visual feedback - briefly flash the button
        filterBtn.style.backgroundColor = '#ff6b6b'
        setTimeout(() => {
          filterBtn.style.backgroundColor = ''
        }, 200)
      }
    })
  }

  // Consolidated Delay button
  const delayBtn = document.getElementById('delayBtn')
  if (delayBtn) {
    delayBtn.addEventListener('click', () => {
      if (nodePool.getAvailableDelayCount() > 0) {
        enterParameterControl('delay', 'Delay Settings', '') // New parameter type 'delay'
      }

      else {
        console.warn('No delay nodes available')
        // Visual feedback - briefly flash the button
        delayBtn.style.backgroundColor = '#ff6b6b'
        setTimeout(() => {
          delayBtn.style.backgroundColor = ''
        }, 200)
      }
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

  // Delay time slider
  const delayTimeSlider = document.getElementById('delayTimeSlider') as HTMLInputElement
  if (delayTimeSlider) {
    delayTimeSlider.addEventListener('input', (e) => {
      const value = parseFloat((e.target as HTMLInputElement).value)
      handleDelayTimeChange(value)
    })
  }

  // Delay Wet slider
  const delayWetSlider = document.getElementById('delayWetSlider') as HTMLInputElement
  if (delayWetSlider) {
    delayWetSlider.addEventListener('input', (e) => {
      const value = parseFloat((e.target as HTMLInputElement).value)
      handleDelayWetChange(value)
    })
  }

  // Delay Feedback slider
  const delayFeedbackSlider = document.getElementById('delayFeedbackSlider') as HTMLInputElement
  if (delayFeedbackSlider) {
    delayFeedbackSlider.addEventListener('input', (e) => {
      const value = parseFloat((e.target as HTMLInputElement).value)
      handleDelayFeedbackChange(value)
    })
  }

  // Delay navigation buttons
  const delayNavPrev = document.getElementById('delayNavPrev')
  if (delayNavPrev) {
    delayNavPrev.addEventListener('click', () => {
      navigateDelayPreset('prev')
    })
  }

  const delayNavNext = document.getElementById('delayNavNext')
  if (delayNavNext) {
    delayNavNext.addEventListener('click', () => {
      navigateDelayPreset('next')
    })
  }

  // Master Filter button
  const masterFilterBtn = document.getElementById('masterFilterBtn')
  if (masterFilterBtn) {
    masterFilterBtn.addEventListener('click', () => {
      enterMasterParameterControl('filter', 'Master Filter', 'Hz')
    })
  }

  // Master Delay button
  const masterDelayBtn = document.getElementById('masterDelayBtn')
  if (masterDelayBtn) {
    masterDelayBtn.addEventListener('click', () => {
      enterMasterParameterControl('delay', 'Master Delay Settings', '')
    })
  }
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

    // Initialize with current preset index based on current settings
    // Find the closest preset or default to 'Off' (index 0)
    currentDelayPresetIndex = 0 // Start with 'Off' preset
    for (let i = 0; i < delayPresets.length; i++) {
      const preset = delayPresets[i]
      if (Math.abs(preset.wet - cellParams.delayWet) < 0.05 &&
        Math.abs(preset.feedback - cellParams.delayFeedback) < 0.05) {
        currentDelayPresetIndex = i
        break
      }
    }

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
          parameterSlider.max = '90' // Cap at 90% to ensure max 0.90 value
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
  // Handle master effects
  if (controlState.currentParameter?.startsWith('master_')) {
    // Convert slider value (0-100) to exponential delay time (0-1)
    const normalizedValue = sliderValue / 100 // 0-1
    const exponentialValue = Math.pow(normalizedValue, 3) // Exponential curve

    // Update master effect parameter
    setMasterEffectParameter('delayTime', exponentialValue)

    // Calculate actual delay time in ms for display
    const delayTimeMs = 0.1 + (exponentialValue * 1999.9)

    // Update display
    const delayParameterValue = document.getElementById('delayParameterValue')
    if (delayParameterValue) {
      delayParameterValue.textContent = `${delayTimeMs.toFixed(1)}ms`
    }

    console.log(`🎛️ Master Delay time: slider=${sliderValue}%, exponential=${exponentialValue.toFixed(3)}, ms=${delayTimeMs.toFixed(1)}`)
    return
  }

  // Handle individual cell effects
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
  // Handle master effects
  if (controlState.currentParameter?.startsWith('master_')) {
    const actualValue = sliderValue / 100 // Convert percentage to 0-1

    // Update master effect parameter
    setMasterEffectParameter('delayWet', actualValue)

    // Update display for delayWetSlider
    const delayWetParameterValue = document.getElementById('delayWetParameterValue')
    if (delayWetParameterValue) {
      delayWetParameterValue.textContent = `${sliderValue}%`
    }

    console.log(`🎛️ Master Delay wet: ${sliderValue}%`)
    return
  }

  // Handle individual cell effects
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
  // Handle master effects
  if (controlState.currentParameter?.startsWith('master_')) {
    // Cap feedback at 90% on slider (0-90 range) to ensure max 0.90 value
    const cappedSliderValue = Math.min(90, Math.max(0, sliderValue))
    const actualValue = cappedSliderValue / 100 // Convert percentage to 0-0.90 range

    // Update master effect parameter
    setMasterEffectParameter('delayFeedback', actualValue)

    // Update display for delayFeedbackSlider
    const delayFeedbackParameterValue = document.getElementById('delayFeedbackParameterValue')
    if (delayFeedbackParameterValue) {
      delayFeedbackParameterValue.textContent = `${cappedSliderValue}%`
    }

    console.log(`🎛️ Master Delay feedback: ${cappedSliderValue}%`)
    return
  }

  // Handle individual cell effects
  if (controlState.controlledCellIndex === null) return

  // Cap feedback at 90% on slider (0-90 range) to ensure max 0.90 value
  const cappedSliderValue = Math.min(90, Math.max(0, sliderValue))
  const actualValue = cappedSliderValue / 100 // Convert percentage to 0-0.90 range

  // Update parameter value with capped value
  setCellParameter(controlState.controlledCellIndex, 'delayFeedback', actualValue)

  // Update display for delayFeedbackSlider
  const delayFeedbackParameterValue = document.getElementById('delayFeedbackParameterValue')
  if (delayFeedbackParameterValue) {
    delayFeedbackParameterValue.textContent = `${cappedSliderValue}%`
  }
}

function handleParameterChange(sliderValue: number): void {
  // Handle master effects
  if (controlState.currentParameter?.startsWith('master_')) {
    const masterParameter = controlState.currentParameter.replace('master_', '') as keyof MasterEffectParameters

    let actualValue = sliderValue
    let displayText = ''

    // Convert slider value to actual parameter value
    if (masterParameter === 'filter') {
      actualValue = sliderValue / 100 // Convert percentage to -1 to 1
      if (sliderValue > 0) {
        displayText = `High-pass ${sliderValue}%`
      }

      else if (sliderValue < 0) {
        displayText = `Low-pass ${Math.abs(sliderValue)}%`
      }

      else {
        displayText = 'No Filter'
      }
    }

    // Update master effect parameter
    setMasterEffectParameter(masterParameter, actualValue)

    // Update display
    const sliderParameterValue = document.getElementById('sliderParameterValue')
    if (sliderParameterValue) {
      sliderParameterValue.textContent = displayText
    }

    return
  }

  // Handle individual cell effects
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
      actualValue = sliderValue / 100 // Convert percentage to 0-0.90 range
      actualValue = Math.min(0.90, actualValue) // Ensure never exceeds 0.90
      displayValue = Math.round(actualValue * 100)
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

  // Remove active state from effect button
  const effectBtn = document.getElementById('effectBtn')
  if (effectBtn) {
    effectBtn.classList.remove('active')
  }

  console.log(`📊 State after: mode=${controlState.mode}, isActive=${controlState.isActive}`)
  console.log('📝 Returned to initial control state')
}

function showInitialControls(): void {
  const initialControls = document.getElementById('initialControls')
  const cellSelectedControls = document.getElementById('cellSelectedControls')
  const masterEffectsControls = document.getElementById('masterEffectsControls')
  const parameterControl = document.getElementById('parameterControl')

  if (initialControls) initialControls.style.display = 'flex'
  if (cellSelectedControls) cellSelectedControls.style.display = 'none'
  if (masterEffectsControls) masterEffectsControls.style.display = 'none'
  if (parameterControl) parameterControl.style.display = 'none'

  // Update control availability when returning to initial state
  updateControlsAvailability()
}

function showCellSelectedControls(): void {
  const initialControls = document.getElementById('initialControls')
  const cellSelectedControls = document.getElementById('cellSelectedControls')
  const parameterControl = document.getElementById('parameterControl')

  if (initialControls) initialControls.style.display = 'none'
  if (cellSelectedControls) cellSelectedControls.style.display = 'flex'
  if (parameterControl) parameterControl.style.display = 'none'

  // Update control availability when showing cell controls
  updateControlsAvailability()
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
  private masterFilterNode: BiquadFilterNode | null = null
  private masterDelayNode: AudioWorkletNode | null = null
  private masterDelayParams: { delay: AudioParam | undefined; feedback: AudioParam | undefined } = { delay: undefined, feedback: undefined }
  private masterDelayWetNode: GainNode | null = null
  private masterDelayDryNode: GainNode | null = null
  private isDelayReady = false // Track if delay worklet is registered
  private isPlaying = false
  private startTime = 0
  private activeSources: Map<number, {
    source: AudioBufferSourceNode
    gainNode: GainNode
    filterNode: BiquadFilterNode
    delayNode: AudioWorkletNode // DelayNode instance
    delayParams: { delay: AudioParam | undefined; feedback: AudioParam | undefined } // Delay parameters
    delayWetNode: GainNode
    delayDryNode: GainNode
    stem: Stem
    currentLoopFraction: number
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

      // Create master effect nodes
      this.masterFilterNode = this.audioContext.createBiquadFilter()
      this.masterFilterNode.type = 'allpass' // Start with no filter

      // Create master delay nodes
      this.masterDelayWetNode = this.audioContext.createGain()
      this.masterDelayDryNode = this.audioContext.createGain()
      this.masterDelayWetNode.gain.setValueAtTime(0, this.audioContext.currentTime) // Start with no delay wet
      this.masterDelayDryNode.gain.setValueAtTime(1, this.audioContext.currentTime) // Full dry by default

      // Set up master audio chain: masterGain -> masterFilter -> delay chain -> destination
      this.masterGainNode.connect(this.masterFilterNode)

      // Connect to both dry and delay paths
      this.masterFilterNode.connect(this.masterDelayDryNode)
      this.masterDelayDryNode.connect(this.audioContext.destination)

      // Resume context if suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume()
      }

      // Initialize DelayNode worklet registration once
      console.log('Initializing DelayNode worklet...')
      const testDelay = await Delay(this.audioContext)
      this.isDelayReady = true
      // Disconnect the test delay node as we just needed it for worklet registration
      testDelay.node.disconnect()
      console.log('DelayNode worklet ready')

      // Create master delay node after worklet is ready
      const masterDelay = await Delay(this.audioContext)
      this.masterDelayNode = masterDelay.node
      this.masterDelayParams = {
        delay: masterDelay.delay,
        feedback: masterDelay.feedback
      }

      // Connect master delay to wet path
      this.masterFilterNode.connect(this.masterDelayNode)
      this.masterDelayNode.connect(this.masterDelayWetNode)
      this.masterDelayWetNode.connect(this.audioContext.destination)

      // Initialize node pools
      await nodePool.initialize(this.audioContext)

      this.updateBarDuration()
      this.isInitialized = true

      // Update control availability once pools are ready
      updateControlsAvailability()

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

  async addStem(cellIndex: number, stem: Stem): Promise<void> {
    if (!this.audioContext || !this.masterGainNode || !stem.buffer) {
      console.warn('Cannot add stem: audio context, master gain, or stem buffer not ready')
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

      // Get cell parameters to check if we need delay/filter
      const params = getCellParameters(cellIndex)

      // Try to get pooled nodes if they're needed
      let pooledDelayNode: PooledDelayNode | null = null
      let pooledFilterNode: PooledFilterNode | null = null

      if (params.delayWet > 0) {
        pooledDelayNode = nodePool.assignDelayNode(cellIndex)
        if (!pooledDelayNode) {
          console.warn(`No available delay nodes for cell ${cellIndex}`)
        }
      }

      if (params.filter !== 0) {
        pooledFilterNode = nodePool.assignFilterNode(cellIndex)
        if (!pooledFilterNode) {
          console.warn(`No available filter nodes for cell ${cellIndex}`)
        }
      }

      // Set up audio chain
      let audioChainEnd: AudioNode = source

      // Add delay if available
      if (pooledDelayNode) {
        // Connect source to both dry and delay paths
        source.connect(pooledDelayNode.delayDryNode)
        source.connect(pooledDelayNode.delayNode)
        pooledDelayNode.delayNode.connect(pooledDelayNode.delayWetNode)

        // Create a mixer for wet/dry signals
        const mixerNode = this.audioContext.createGain()
        pooledDelayNode.delayDryNode.connect(mixerNode)
        pooledDelayNode.delayWetNode.connect(mixerNode)

        audioChainEnd = mixerNode
      }

      // Add filter if available
      if (pooledFilterNode) {
        audioChainEnd.connect(pooledFilterNode.filterNode)
        audioChainEnd = pooledFilterNode.filterNode
      }

      // Connect final output to gain node
      audioChainEnd.connect(gainNode)
      gainNode.connect(this.masterGainNode)

      // Store reference with pooled nodes
      this.activeSources.set(cellIndex, {
        source,
        gainNode,
        filterNode: pooledFilterNode?.filterNode || this.audioContext.createBiquadFilter(), // Fallback for compatibility
        delayNode: pooledDelayNode?.delayNode || null as any, // Will be null if no pooled node
        delayParams: pooledDelayNode?.delayParams || { delay: undefined, feedback: undefined },
        delayWetNode: pooledDelayNode?.delayWetNode || this.audioContext.createGain(),
        delayDryNode: pooledDelayNode?.delayDryNode || this.audioContext.createGain(),
        stem,
        currentLoopFraction: 1
      })

      // Apply cell parameters
      this.applyCellParameters(cellIndex, params)

      // Calculate when to start based on bar alignment
      let startTime: number
      if (this.isPlaying) {
        // Start at the next bar boundary
        startTime = this.getNextBarStartTime()
        const timeToNext = startTime - this.audioContext.currentTime
        console.log(`Scheduling "${stem.name}" to start in ${timeToNext.toFixed(2)}s at next bar`)
      }

      else {
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
    if (!this.audioContext || !sourceInfo.delayParams) return

    // Calculate delay time in seconds with exponential mapping
    // 0-1 maps to 0.1ms-2000ms exponentially for flanger to long delay
    const exponentialValue = Math.pow(delayTime, 3) // Cubic curve for more room at small values
    const delayTimeMs = 0.1 + (exponentialValue * 1999.9) // 0.1ms to 2000ms
    const delayTimeSeconds = delayTimeMs / 1000

    // Apply delay time to the DelayNode
    if (sourceInfo.delayParams.delay) {
      sourceInfo.delayParams.delay.setValueAtTime(delayTimeSeconds, this.audioContext.currentTime)
    }

    // Apply feedback to the DelayNode
    if (sourceInfo.delayParams.feedback) {
      // feedbackAmount is 0-1 from slider, DelayNode expects 0-0.95
      sourceInfo.delayParams.feedback.setValueAtTime(Math.min(0.95, feedbackAmount), this.audioContext.currentTime)
    }

    // Apply wet/dry mix (Dry is always 100%, Wet controls the amount of delayed signal)
    sourceInfo.delayWetNode.gain.setValueAtTime(wetAmount, this.audioContext.currentTime)
    sourceInfo.delayDryNode.gain.setValueAtTime(1, this.audioContext.currentTime)

    console.log(`🔄 DelayNode: ${delayTimeMs.toFixed(1)}ms, Wet: ${(wetAmount * 100).toFixed(0)}%, Dry: 100%, Feedback: ${(Math.min(0.95, feedbackAmount) * 100).toFixed(0)}%`)
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

  private async applyLoopFractionChange(cellIndex: number, newFraction: number): Promise<void> {
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
      await this.addStem(cellIndex, stem)
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

    // Release pooled nodes
    nodePool.releaseDelayNode(cellIndex)
    nodePool.releaseFilterNode(cellIndex)

    console.log(`Removed stem: ${sourceInfo.stem.name}`)
  }

  async updateActiveStems(activeCells: number[], allCells: StemCell[]): Promise<void> {
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
          await this.addStem(cellIndex, stem)
        }
      }
    }
  }

  setMasterVolume(volume: number): void {
    if (this.masterGainNode) {
      this.masterGainNode.gain.setValueAtTime(volume, this.audioContext?.currentTime || 0)
    }
  }

  updateMasterFilterParameter(filterValue: number): void {
    if (!this.audioContext || !this.masterFilterNode) return

    if (filterValue === 0) {
      // No filter - use allpass which doesn't affect the signal
      this.masterFilterNode.type = 'allpass'
    }

    else if (filterValue > 0) {
      // High-pass filter for positive values
      this.masterFilterNode.type = 'highpass'
      const exponentialValue = Math.pow(filterValue, 1)
      const frequency = 20 * Math.pow(8000 / 20, exponentialValue)
      this.masterFilterNode.frequency.setValueAtTime(frequency, this.audioContext.currentTime)
      this.masterFilterNode.Q.setValueAtTime(3, this.audioContext.currentTime)
    }

    else {
      // Low-pass filter for negative values
      this.masterFilterNode.type = 'lowpass'
      const absValue = Math.abs(filterValue)
      const exponentialValue = Math.pow(absValue, 3.5)
      const frequency = 8000 * Math.pow(20 / 8000, exponentialValue)
      this.masterFilterNode.frequency.setValueAtTime(frequency, this.audioContext.currentTime)
      this.masterFilterNode.Q.setValueAtTime(3, this.audioContext.currentTime)
    }
  }

  updateMasterDelayParameters(wetAmount: number, delayTime: number, feedbackAmount: number): void {
    if (!this.audioContext || !this.masterDelayParams.delay || !this.masterDelayParams.feedback ||
      !this.masterDelayWetNode || !this.masterDelayDryNode) return

    // Calculate delay time in seconds with exponential mapping
    const exponentialValue = Math.pow(delayTime, 3)
    const delayTimeMs = 0.1 + (exponentialValue * 1999.9)
    const delayTimeSeconds = delayTimeMs / 1000

    // Apply delay time
    this.masterDelayParams.delay.setValueAtTime(delayTimeSeconds, this.audioContext.currentTime)

    // Apply feedback (capped at 0.95)
    this.masterDelayParams.feedback.setValueAtTime(Math.min(0.95, feedbackAmount), this.audioContext.currentTime)

    // Apply wet/dry mix
    this.masterDelayWetNode.gain.setValueAtTime(wetAmount, this.audioContext.currentTime)
    this.masterDelayDryNode.gain.setValueAtTime(1, this.audioContext.currentTime)

    console.log(`🎛️ Master Delay: ${delayTimeMs.toFixed(1)}ms, Wet: ${(wetAmount * 100).toFixed(0)}%, Feedback: ${(Math.min(0.95, feedbackAmount) * 100).toFixed(0)}%`)
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
  init: (): Promise<void> => init(),

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
}

// Audio Node Pools System
interface PooledDelayNode {
  delayNode: AudioWorkletNode
  delayParams: { delay: AudioParam | undefined; feedback: AudioParam | undefined }
  delayWetNode: GainNode
  delayDryNode: GainNode
  isAvailable: boolean
  assignedCellIndex: number | null
}

interface PooledFilterNode {
  filterNode: BiquadFilterNode
  isAvailable: boolean
  assignedCellIndex: number | null
}

class NodePool {
  private delayPool: PooledDelayNode[] = []
  private filterPool: PooledFilterNode[] = []
  private audioContext: AudioContext | null = null

  async initialize(audioContext: AudioContext): Promise<void> {
    this.audioContext = audioContext

    // Initialize delay pool (8 nodes)
    for (let i = 0; i < 8; i++) {
      const delayResult = await Delay(audioContext)
      const delayWetNode = audioContext.createGain()
      const delayDryNode = audioContext.createGain()

      delayWetNode.gain.setValueAtTime(0, audioContext.currentTime)
      delayDryNode.gain.setValueAtTime(1, audioContext.currentTime)

      this.delayPool.push({
        delayNode: delayResult.node,
        delayParams: { delay: delayResult.delay, feedback: delayResult.feedback },
        delayWetNode,
        delayDryNode,
        isAvailable: true,
        assignedCellIndex: null
      })
    }

    // Initialize filter pool (8 nodes)
    for (let i = 0; i < 8; i++) {
      const filterNode = audioContext.createBiquadFilter()
      filterNode.type = 'allpass'
      filterNode.frequency.setValueAtTime(1000, audioContext.currentTime)

      this.filterPool.push({
        filterNode,
        isAvailable: true,
        assignedCellIndex: null
      })
    }

    console.log('Node pools initialized: 8 delay nodes, 8 filter nodes')
  }

  assignDelayNode(cellIndex: number): PooledDelayNode | null {
    const availableNode = this.delayPool.find(node => node.isAvailable)
    if (availableNode) {
      availableNode.isAvailable = false
      availableNode.assignedCellIndex = cellIndex
      return availableNode
    }
    return null
  }

  assignFilterNode(cellIndex: number): PooledFilterNode | null {
    const availableNode = this.filterPool.find(node => node.isAvailable)
    if (availableNode) {
      availableNode.isAvailable = false
      availableNode.assignedCellIndex = cellIndex
      return availableNode
    }
    return null
  }

  releaseDelayNode(cellIndex: number): void {
    const node = this.delayPool.find(node => node.assignedCellIndex === cellIndex)
    if (node && this.audioContext) {
      // Reset delay parameters
      if (node.delayParams.delay) {
        node.delayParams.delay.setValueAtTime(0, this.audioContext.currentTime)
      }
      if (node.delayParams.feedback) {
        node.delayParams.feedback.setValueAtTime(0, this.audioContext.currentTime)
      }
      node.delayWetNode.gain.setValueAtTime(0, this.audioContext.currentTime)
      node.delayDryNode.gain.setValueAtTime(1, this.audioContext.currentTime)

      // Disconnect all connections
      node.delayNode.disconnect()
      node.delayWetNode.disconnect()
      node.delayDryNode.disconnect()

      node.isAvailable = true
      node.assignedCellIndex = null
    }
  }

  releaseFilterNode(cellIndex: number): void {
    const node = this.filterPool.find(node => node.assignedCellIndex === cellIndex)
    if (node && this.audioContext) {
      // Reset filter to allpass
      node.filterNode.type = 'allpass'
      node.filterNode.frequency.setValueAtTime(1000, this.audioContext.currentTime)

      // Disconnect all connections
      node.filterNode.disconnect()

      node.isAvailable = true
      node.assignedCellIndex = null
    }
  }

  releaseAllNodes(): void {
    // Track cells that need to be restarted
    const cellsToRestart: number[] = []

    // Release all delay nodes and track affected cells
    this.delayPool.forEach((node) => {
      if (!node.isAvailable && node.assignedCellIndex !== null) {
        cellsToRestart.push(node.assignedCellIndex)
        this.releaseDelayNode(node.assignedCellIndex)
      }
    })

    // Release all filter nodes and track affected cells
    this.filterPool.forEach((node) => {
      if (!node.isAvailable && node.assignedCellIndex !== null) {
        if (!cellsToRestart.includes(node.assignedCellIndex)) {
          cellsToRestart.push(node.assignedCellIndex)
        }
        this.releaseFilterNode(node.assignedCellIndex)
      }
    })

    // Reset all cell parameters that use delay/filter
    cellParameters.forEach((params, cellIndex) => {
      if (params.delayWet > 0) {
        params.delayWet = 0
      }
      if (params.filter !== 0) {
        params.filter = 0
      }
    })

    // Restart affected stems that are currently active to reconnect them properly
    cellsToRestart.forEach(cellIndex => {
      const cell = gridCells[cellIndex]
      if (cell && cell.isActive && cell.stem && audioScheduler.isAudioInitialized()) {
        // Remove and re-add the stem to reconnect it properly
        audioScheduler.removeStem(cellIndex)
        audioScheduler.addStem(cellIndex, cell.stem)
      }
    })

    updateCellVisuals()
    console.log(`All pool nodes released and ${cellsToRestart.length} stems reconnected`)
  }

  getAvailableDelayCount(): number {
    return this.delayPool.filter(node => node.isAvailable).length
  }

  getAvailableFilterCount(): number {
    return this.filterPool.filter(node => node.isAvailable).length
  }

  getAssignedDelayNode(cellIndex: number): PooledDelayNode | null {
    return this.delayPool.find(node => node.assignedCellIndex === cellIndex) || null
  }

  getAssignedFilterNode(cellIndex: number): PooledFilterNode | null {
    return this.filterPool.find(node => node.assignedCellIndex === cellIndex) || null
  }

  getDelayNodeIndex(cellIndex: number): number {
    const nodeIndex = this.delayPool.findIndex(node => node.assignedCellIndex === cellIndex)
    return nodeIndex >= 0 ? nodeIndex + 1 : -1 // Return 1-based index for display
  }

  getFilterNodeIndex(cellIndex: number): number {
    const nodeIndex = this.filterPool.findIndex(node => node.assignedCellIndex === cellIndex)
    return nodeIndex >= 0 ? nodeIndex + 1 : -1 // Return 1-based index for display
  }
}

// Global node pool instance
const nodePool = new NodePool()

// Update controls availability based on pool state
function updateControlsAvailability(): void {
  const filterBtn = document.getElementById('filterBtn')
  const delayBtn = document.getElementById('delayBtn')

  if (filterBtn) {
    const filterAvailable = nodePool.getAvailableFilterCount() > 0
    filterBtn.style.opacity = filterAvailable ? '1' : '0.3'
    filterBtn.style.pointerEvents = filterAvailable ? 'auto' : 'none'
    filterBtn.title = filterAvailable ? '' : `No filter nodes available (${nodePool.getAvailableFilterCount()}/8)`
  }

  if (delayBtn) {
    const delayAvailable = nodePool.getAvailableDelayCount() > 0
    delayBtn.style.opacity = delayAvailable ? '1' : '0.3'
    delayBtn.style.pointerEvents = delayAvailable ? 'auto' : 'none'
    delayBtn.title = delayAvailable ? '' : `No delay nodes available (${nodePool.getAvailableDelayCount()}/8)`
  }
}

// Delay preset management
interface DelayPreset {
  name: string
  wet: number // 0-1
  feedback: number // 0-0.95
  time: number // 0-1 (exponential mapped)
  syncFraction?: number // Optional BPM sync fraction
}

const delayPresets: DelayPreset[] = [
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

let currentDelayPresetIndex = 0

function applyDelayPreset(presetIndex: number): void {
  if (controlState.controlledCellIndex === null) return

  const preset = delayPresets[presetIndex]
  if (!preset) return

  const cellIndex = controlState.controlledCellIndex

  // Get the stem's BPM if we need to sync
  let timeValue = preset.time
  if (preset.syncFraction) {
    const cell = gridCells[cellIndex]
    if (cell?.stem?.bpm) {
      // Calculate BPM-synced delay time
      timeValue = audioScheduler.calculateBPMDelayTime(preset.syncFraction, cell.stem.bpm)
    }
  }

  // Apply preset values
  setCellParameter(cellIndex, 'delayWet', preset.wet)
  setCellParameter(cellIndex, 'delayFeedback', preset.feedback)
  setCellParameter(cellIndex, 'delayTime', timeValue)

  // Update sliders to reflect new values
  updateDelayControlsDisplay(preset, timeValue)

  console.log(`Applied delay preset: ${preset.name}`)
}

function updateDelayControlsDisplay(preset: DelayPreset, timeValue: number): void {
  // Update Delay Wet
  const delayWetSlider = document.getElementById('delayWetSlider') as HTMLInputElement
  const delayWetParameterValue = document.getElementById('delayWetParameterValue')
  if (delayWetSlider && delayWetParameterValue) {
    const wetPercent = Math.round(preset.wet * 100)
    delayWetSlider.value = wetPercent.toString()
    delayWetParameterValue.textContent = `${wetPercent}%`
  }

  // Update Delay Feedback
  const delayFeedbackSlider = document.getElementById('delayFeedbackSlider') as HTMLInputElement
  const delayFeedbackParameterValue = document.getElementById('delayFeedbackParameterValue')
  if (delayFeedbackSlider && delayFeedbackParameterValue) {
    const feedbackPercent = Math.round(preset.feedback * 100)
    delayFeedbackSlider.value = feedbackPercent.toString()
    delayFeedbackParameterValue.textContent = `${feedbackPercent}%`
  }

  // Update Delay Time
  const delayTimeSlider = document.getElementById('delayTimeSlider') as HTMLInputElement
  const delayParameterValue = document.getElementById('delayParameterValue')
  if (delayTimeSlider && delayParameterValue) {
    const timePercent = Math.round(timeValue * 100)
    delayTimeSlider.value = timePercent.toString()

    // Calculate actual delay time in ms for display
    const exponentialValue = Math.pow(timeValue, 3)
    const delayTimeMs = 0.1 + (exponentialValue * 1999.9)

    if (preset.syncFraction) {
      const fractionNames: { [key: number]: string } = {
        0.03125: '1/32',
        0.0625: '1/16',
        0.08333333333: '1/12',
        0.125: '1/8',
        0.16666666666: '1/6',
        0.25: '1/4',
        0.33333333333: '1/3',
        0.5: '1/2'
      }
      const fractionName = fractionNames[preset.syncFraction] || `${preset.syncFraction}`
      delayParameterValue.textContent = `${fractionName} (${delayTimeMs.toFixed(1)}ms)`
    } else {
      delayParameterValue.textContent = `${delayTimeMs.toFixed(1)}ms`
    }
  }
}

function navigateDelayPreset(direction: 'prev' | 'next'): void {
  if (direction === 'next') {
    currentDelayPresetIndex = (currentDelayPresetIndex + 1) % delayPresets.length
  } else {
    currentDelayPresetIndex = (currentDelayPresetIndex - 1 + delayPresets.length) % delayPresets.length
  }

  applyDelayPreset(currentDelayPresetIndex)

  // Provide user feedback in delay time display
  const preset = delayPresets[currentDelayPresetIndex]
  const delayParameterValue = document.getElementById('delayParameterValue')
  if (delayParameterValue) {
    // Temporarily show preset name
    delayParameterValue.textContent = `${preset.name}`
    delayParameterValue.style.fontWeight = 'bold'
    delayParameterValue.style.color = '#667eea'

    // Revert to time display after 1 second
    setTimeout(() => {
      const cellParams = getCellParameters(controlState.controlledCellIndex!)
      if (cellParams) {
        const exponentialValue = Math.pow(cellParams.delayTime, 3)
        const delayTimeMs = 0.1 + (exponentialValue * 1999.9)

        if (preset.syncFraction) {
          const fractionNames: { [key: number]: string } = {
            0.03125: '1/32',
            0.0625: '1/16',
            0.08333333333: '1/12',
            0.125: '1/8',
            0.16666666666: '1/6',
            0.25: '1/4',
            0.33333333333: '1/3',
            0.5: '1/2'
          }
          const fractionName = fractionNames[preset.syncFraction] || `${preset.syncFraction}`
          delayParameterValue.textContent = `${fractionName} (${delayTimeMs.toFixed(1)}ms)`
        } else {
          delayParameterValue.textContent = `${delayTimeMs.toFixed(1)}ms`
        }

        delayParameterValue.style.fontWeight = ''
        delayParameterValue.style.color = ''
      }
    }, 1000)
  }

  console.log(`Delay preset: ${preset.name} (${currentDelayPresetIndex + 1}/${delayPresets.length})`)
}

// Master effect parameter functions
function setMasterEffectParameter(parameter: keyof MasterEffectParameters, value: number): void {
  // Apply safety caps for specific parameters
  if (parameter === 'delayFeedback') {
    value = Math.min(0.90, Math.max(0, value))
  }

  else if (parameter === 'delayWet') {
    value = Math.min(1, Math.max(0, value))
  }

  masterEffectParameters[parameter] = value

  // Update audio
  if (audioScheduler.isAudioInitialized()) {
    if (parameter === 'filter') {
      audioScheduler.updateMasterFilterParameter(value)
    }

    else if (parameter === 'delayWet' || parameter === 'delayTime' || parameter === 'delayFeedback') {
      audioScheduler.updateMasterDelayParameters(
        masterEffectParameters.delayWet,
        masterEffectParameters.delayTime,
        masterEffectParameters.delayFeedback
      )
    }
  }
}

// Master effects mode functions
function enterMasterEffectsMode(): void {
  console.log('🎛️ Entering master effects mode')

  controlState.mode = 'masterEffects'
  controlState.isActive = true
  controlState.controlledCellIndex = null
  controlState.currentParameter = null

  // Hide other control panels
  const initialControls = document.getElementById('initialControls')
  const cellSelectedControls = document.getElementById('cellSelectedControls')
  const parameterControl = document.getElementById('parameterControl')
  const masterEffectsControls = document.getElementById('masterEffectsControls')

  if (initialControls) initialControls.style.display = 'none'
  if (cellSelectedControls) cellSelectedControls.style.display = 'none'
  if (parameterControl) parameterControl.style.display = 'none'
  if (masterEffectsControls) masterEffectsControls.style.display = 'flex'

  // Update button visual state
  const effectBtn = document.getElementById('effectBtn')
  if (effectBtn) effectBtn.classList.add('active')
}

function enterMasterParameterControl(parameter: string, label: string, unit: string): void {
  console.log(`🎛️ Entering master parameter control: ${parameter}`)

  controlState.mode = 'parameterControl'
  controlState.currentParameter = 'master_' + parameter

  // Hide master effects controls, show parameter control
  const masterEffectsControls = document.getElementById('masterEffectsControls')
  const parameterControl = document.getElementById('parameterControl')

  if (masterEffectsControls) masterEffectsControls.style.display = 'none'
  if (parameterControl) parameterControl.style.display = 'flex'

  // Hide all parameter control sub-panels first
  const loopFractionControl = document.getElementById('loopFractionControl')
  const sliderControl = document.getElementById('sliderControl')
  const delaySettingsControl = document.getElementById('delaySettingsControl')

  if (loopFractionControl) loopFractionControl.style.display = 'none'
  if (sliderControl) sliderControl.style.display = 'none'
  if (delaySettingsControl) delaySettingsControl.style.display = 'none'

  if (parameter === 'delay') {
    // Show delay settings control for master delay
    if (delaySettingsControl) delaySettingsControl.style.display = 'flex'

    // Setup master delay controls
    const delayWetSlider = document.getElementById('delayWetSlider') as HTMLInputElement
    const delayWetParameterValue = document.getElementById('delayWetParameterValue')
    if (delayWetSlider && delayWetParameterValue) {
      const currentDelayWet = Math.round(masterEffectParameters.delayWet * 100)
      delayWetSlider.value = currentDelayWet.toString()
      delayWetParameterValue.textContent = `${currentDelayWet}%`
    }

    updateDelayTimeControl(masterEffectParameters.delayTime)

    const delayFeedbackSlider = document.getElementById('delayFeedbackSlider') as HTMLInputElement
    const delayFeedbackParameterValue = document.getElementById('delayFeedbackParameterValue')
    if (delayFeedbackSlider && delayFeedbackParameterValue) {
      const currentDelayFeedback = Math.round(masterEffectParameters.delayFeedback * 100)
      delayFeedbackSlider.value = currentDelayFeedback.toString()
      delayFeedbackParameterValue.textContent = `${currentDelayFeedback}%`
    }
  }

  else {
    // Generic slider case (filter)
    if (sliderControl) sliderControl.style.display = 'flex'

    const sliderParameterLabel = document.getElementById('sliderParameterLabel')
    if (sliderParameterLabel) sliderParameterLabel.textContent = label

    const parameterSlider = document.getElementById('parameterSlider') as HTMLInputElement
    const sliderParameterValue = document.getElementById('sliderParameterValue')

    if (parameterSlider && sliderParameterValue) {
      let currentValue = masterEffectParameters[parameter as keyof MasterEffectParameters]

      if (parameter === 'filter') {
        parameterSlider.min = '-100'
        parameterSlider.max = '100'
        currentValue = Math.round(currentValue * 100)
        parameterSlider.value = currentValue.toString()

        if (currentValue > 0) {
          sliderParameterValue.textContent = `High-pass ${currentValue}%`
        }

        else if (currentValue < 0) {
          sliderParameterValue.textContent = `Low-pass ${Math.abs(currentValue)}%`
        }

        else {
          sliderParameterValue.textContent = 'No Filter'
        }
      }
    }
  }
}
