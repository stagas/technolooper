import type { Stem, StemCell } from './types.ts'
import { StemColors } from './types.ts'

// Grid configuration
let defaultGridSize = 0 // Start with 0 cells, grow as stems are added
let gridSize = defaultGridSize
let gridCells: StemCell[] = []

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
function createGrid(onCellClick: (index: number) => void): void {
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
    cell.addEventListener('click', () => onCellClick(i))
    cell.addEventListener('touchstart', (e) => {
      e.preventDefault()
      onCellClick(i)
    }, { passive: false })

    container.appendChild(cell)
    gridCells[i].element = cell
  }

  updateCellVisuals()
}

// Update visual for a specific cell
function updateCellVisual(index: number, getCellParameters: (index: number) => any, nodePool: any): void {
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

  // If loading, add loading indicator
  if (isLoading) {
    cell.classList.add('loading')

    // Add loading spinner
    const spinner = document.createElement('div')
    spinner.innerHTML = '⏳'
    spinner.style.cssText = `
      font-size: 1rem;
      animation: spin 2s linear infinite;
      margin-bottom: 2px;
    `
    contentDiv.appendChild(spinner)

    // Add loading text
    const loadingText = document.createElement('div')
    loadingText.textContent = 'Loading...'
    loadingText.style.cssText = `
      font-size: 0.4rem;
      color: #ccc;
      font-weight: bold;
      text-align: center;
    `
    contentDiv.appendChild(loadingText)

    // Add CSS animation for spinner if not already added
    if (!document.querySelector('#loading-spinner-style')) {
      const style = document.createElement('style')
      style.id = 'loading-spinner-style'
      style.textContent = `
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `
      document.head.appendChild(style)
    }
  }

  // Add pool indicators if active and not loading
  if (isActive && !isLoading) {
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
      // Active but still loading - use grayscale with pulsing animation
      cell.style.backgroundColor = `hsl(${hue}, 25%, ${lightness}%)`
      cell.style.boxShadow = `0 0 15px hsl(${hue}, 25%, ${lightness}%, 0.8)`
      cell.style.animation = 'loadingPulse 1.5s ease-in-out infinite alternate'
    }

    else {
      // Active and loaded - use full color
      cell.style.backgroundColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`
      cell.style.boxShadow = `0 0 25px hsl(${hue}, ${saturation}%, ${lightness}%, 0.6), 0 0 50px hsl(${hue}, ${saturation}%, ${lightness}%, 0.6)`
    }
  }

  else {
    // Inactive state - but still show indicators for modified parameters if not loading
    if (!isLoading) {
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
    }

    if (isLoading) {
      // Loading but inactive - grayscale with subtle animation
      cell.style.backgroundColor = `hsl(${hue}, 20%, ${lightness}%, 0.5)`
      cell.style.animation = 'loadingPulse 2s ease-in-out infinite alternate'
    }

    else {
      // Normal inactive state - dimmed color
      cell.style.backgroundColor = `hsl(${hue}, ${saturation}%, ${lightness}%, 0.25)`
    }
  }

  // Add loading animation CSS if not already added
  if (isLoading && !document.querySelector('#loading-pulse-style')) {
    const style = document.createElement('style')
    style.id = 'loading-pulse-style'
    style.textContent = `
      @keyframes loadingPulse {
        0% { opacity: 0.6; }
        100% { opacity: 1; }
      }
    `
    document.head.appendChild(style)
  }
}

// Update all cell visuals
function updateCellVisuals(getCellParameters?: (index: number) => any, nodePool?: any): void {
  for (let i = 0; i < gridSize; i++) {
    if (getCellParameters && nodePool) {
      updateCellVisual(i, getCellParameters, nodePool)
    } else {
      // Fallback for basic cell rendering without full parameter system
      updateCellVisualBasic(i)
    }
  }
}

// Basic cell visual update without parameters (fallback)
function updateCellVisualBasic(index: number): void {
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

  // If loading, add loading indicator
  if (isLoading) {
    cell.classList.add('loading')

    // Add loading spinner
    const spinner = document.createElement('div')
    spinner.innerHTML = '⏳'
    spinner.style.cssText = `
      font-size: 1rem;
      animation: spin 2s linear infinite;
      margin-bottom: 2px;
    `
    contentDiv.appendChild(spinner)

    // Add loading text
    const loadingText = document.createElement('div')
    loadingText.textContent = 'Loading...'
    loadingText.style.cssText = `
      font-size: 0.4rem;
      color: #ccc;
      font-weight: bold;
      text-align: center;
    `
    contentDiv.appendChild(loadingText)

    // Add CSS animation for spinner if not already added
    if (!document.querySelector('#loading-spinner-style')) {
      const style = document.createElement('style')
      style.id = 'loading-spinner-style'
      style.textContent = `
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `
      document.head.appendChild(style)
    }
  }

  cell.appendChild(contentDiv)

  if (isActive) {
    // Show active state
    cell.classList.add('active')

    if (isLoading) {
      // Active but still loading - use grayscale with pulsing animation
      cell.style.backgroundColor = `hsl(${hue}, 25%, ${lightness}%)`
      cell.style.boxShadow = `0 0 15px hsl(${hue}, 25%, ${lightness}%, 0.8)`
      cell.style.animation = 'loadingPulse 1.5s ease-in-out infinite alternate'
    }

    else {
      // Active and loaded - use full color
      cell.style.backgroundColor = `hsl(${hue}, ${saturation}%, ${lightness}%)`
      cell.style.boxShadow = `0 0 25px hsl(${hue}, ${saturation}%, ${lightness}%, 0.6), 0 0 50px hsl(${hue}, ${saturation}%, ${lightness}%, 0.6)`
    }
  }

  else {
    if (isLoading) {
      // Loading but inactive - grayscale with subtle animation
      cell.style.backgroundColor = `hsl(${hue}, 20%, ${lightness}%, 0.5)`
      cell.style.animation = 'loadingPulse 2s ease-in-out infinite alternate'
    }

    else {
      // Normal inactive state - dimmed color
      cell.style.backgroundColor = `hsl(${hue}, ${saturation}%, ${lightness}%, 0.25)`
    }
  }

  // Add loading animation CSS if not already added
  if (isLoading && !document.querySelector('#loading-pulse-style')) {
    const style = document.createElement('style')
    style.id = 'loading-pulse-style'
    style.textContent = `
      @keyframes loadingPulse {
        0% { opacity: 0.6; }
        100% { opacity: 1; }
      }
    `
    document.head.appendChild(style)
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
  }

  // If we have fewer stems than expected, remove extra loading cells
  if (stems.length < gridCells.length - startIndex) {
    const excessCells = gridCells.length - startIndex - stems.length
    gridCells.splice(gridCells.length - excessCells, excessCells)
    gridSize = gridCells.length
  }
}

// Set loading state for cells
function setCellLoading(indices: number[], loading: boolean): void {
  indices.forEach(index => {
    if (index >= 0 && index < gridCells.length) {
      gridCells[index].isLoading = loading
    }
  })
}

// Add stems without audio buffers (metadata only)
function addStemMetadataToGrid(stemMetadata: Array<{
  name: string
  bpm: number
  kind: any
  fileName: string
  zipFile: any
}>): void {
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
}

// Update a specific cell with decoded audio buffer
function updateCellWithAudioBuffer(cellIndex: number, audioBuffer: AudioBuffer): void {
  if (cellIndex >= 0 && cellIndex < gridCells.length && gridCells[cellIndex].stem) {
    gridCells[cellIndex].stem!.buffer = audioBuffer
    gridCells[cellIndex].isLoading = false
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

export {
  gridCells,
  gridSize,
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
}

function setGridSize(size: number): void {
  if (size > 0 && size <= 1024) {
    gridSize = size
  }
}

function getGridSize(): number {
  return gridSize
}

function getGridCells(): StemCell[] {
  return gridCells
}
