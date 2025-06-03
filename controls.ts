import type { ControlState, CellParameters, MasterEffectParameters } from './types.ts'
import { delayPresets } from './delay-presets.ts'

// Control state management
let controlState: ControlState = {
  mode: 'initial',
  controlledCellIndex: null,
  currentParameter: null,
  isActive: false
}

// Master effect parameters
let masterEffectParameters: MasterEffectParameters = {
  filter: 0, // No filter by default
  delayWet: 0,
  delayTime: 0,
  delayFeedback: 0.3, // Default feedback
  pitchRatio: 1 // No pitch shift by default
}

let currentDelayPresetIndex = 0

// Function to get grid cells and node pool - these will be injected
let getGridCells: () => any[] = () => []
let getCellParameters: (index: number) => CellParameters = () => ({
  loopFraction: 1,
  volume: 1,
  filter: 0,
  delayWet: 0,
  delayTime: 0,
  delayFeedback: 0.3,
  pitchRatio: 1
})
let setCellParameter: (index: number, param: keyof CellParameters, value: number) => void = () => { }
let getNodePool: () => any = () => null
let getAudioScheduler: () => any = () => null

// Inject dependencies
export function initializeControls(deps: {
  getGridCells: () => any[]
  getCellParameters: (index: number) => CellParameters
  setCellParameter: (index: number, param: keyof CellParameters, value: number) => void
  getNodePool: () => any
  getAudioScheduler: () => any
}): void {
  getGridCells = deps.getGridCells
  getCellParameters = deps.getCellParameters
  setCellParameter = deps.setCellParameter
  getNodePool = deps.getNodePool
  getAudioScheduler = deps.getAudioScheduler
}

export function getControlState(): ControlState {
  return { ...controlState }
}

export function getMasterEffectParameters(): MasterEffectParameters {
  return { ...masterEffectParameters }
}

export function setupControlRowEventListeners(): void {
  // Control button
  const controlBtn = document.getElementById('controlBtn')
  if (controlBtn) {
    let clickCount = 0
    controlBtn.addEventListener('click', () => {
      clickCount++
      console.log(`🎛️ Control button clicked #${clickCount}. Current state: mode=${controlState.mode}, isActive=${controlState.isActive}`)

      // Toggle control mode: if already in cell selection mode, turn it off
      if (controlState.mode === 'cellSelection' && controlState.isActive) {
        console.log(`🔄 Click #${clickCount}: Returning to initial state from cell selection`)
        returnToInitialControlState()
      }

      else {
        console.log(`🔄 Click #${clickCount}: Entering cell selection mode`)
        enterCellSelectionMode()
      }
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
      const nodePool = getNodePool()
      const audioScheduler = getAudioScheduler()
      const gridCells = getGridCells()

      // Reset master effect parameters to defaults
      masterEffectParameters.filter = 0
      masterEffectParameters.delayWet = 0
      masterEffectParameters.delayTime = 0
      masterEffectParameters.delayFeedback = 0.3
      masterEffectParameters.pitchRatio = 1

      // Apply master effect resets to audio if initialized
      if (audioScheduler.isAudioInitialized()) {
        audioScheduler.updateMasterFilterParameter(0)
        audioScheduler.updateMasterDelayParameters(0, 0, 0.3)
        audioScheduler.updateMasterPitchParameter(1)
      }

      // Reset all cell parameters that use delay/filter
      gridCells.forEach((cell: any, cellIndex: number) => {
        const params = getCellParameters(cellIndex)
        let needsRestart = false

        // Check if cell has any non-default parameters that require pooled nodes
        if (params.delayWet > 0 || params.filter !== 0 || Math.abs(params.pitchRatio - 1) > 0.001) {
          needsRestart = true
        }

        // Reset parameters to defaults
        setCellParameter(cellIndex, 'loopFraction', 1)
        setCellParameter(cellIndex, 'volume', 1)
        setCellParameter(cellIndex, 'filter', 0)
        setCellParameter(cellIndex, 'delayWet', 0)
        setCellParameter(cellIndex, 'delayTime', 0)
        setCellParameter(cellIndex, 'delayFeedback', 0.3)
        setCellParameter(cellIndex, 'pitchRatio', 1)

        if (needsRestart) {
          cellsToRestart.push(cellIndex)
        }
      })

      // Release all pooled nodes
      const releasedCells = nodePool.releaseAllNodes()

      // Merge the lists (some cells might be in both)
      releasedCells.forEach((cellIndex: number) => {
        if (!cellsToRestart.includes(cellIndex)) {
          cellsToRestart.push(cellIndex)
        }
      })

      // Restart affected stems that are currently active to reconnect them properly
      if (audioScheduler.isAudioInitialized()) {
        cellsToRestart.forEach((cellIndex: number) => {
          const cell = gridCells[cellIndex]
          if (cell && cell.isActive && cell.stem) {
            // Remove and re-add the stem to reconnect it without effects
            audioScheduler.removeStem(cellIndex)
            audioScheduler.addStem(cellIndex, cell.stem, getCellParameters)
          }
        })
      }

      // Update controls availability
      updateControlsAvailability()

      console.log(`✅ All parameters reset and ${cellsToRestart.length} stems reconnected`)
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
      const nodePool = getNodePool()
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

  // Pitch button
  const pitchBtn = document.getElementById('pitchBtn')
  if (pitchBtn) {
    pitchBtn.addEventListener('click', () => {
      const nodePool = getNodePool()
      const audioScheduler = getAudioScheduler()

      // Check if pitch worklets are supported at all
      if (!audioScheduler.isAudioInitialized()) {
        console.warn('Audio not initialized yet')
        pitchBtn.style.backgroundColor = '#ff9f40'
        setTimeout(() => {
          pitchBtn.style.backgroundColor = ''
        }, 1000)
        return
      }

      if (nodePool.getAvailablePitchCount() > 0) {
        enterParameterControl('pitch', 'Pitch Shift', 'x')
      } else {
        console.warn('No pitch nodes available')
        // Check if it's a fundamental support issue vs just no available nodes
        const totalPitchNodes = 8 // We always create 8 pitch nodes if supported
        const assignedNodes = totalPitchNodes - nodePool.getAvailablePitchCount()

        if (assignedNodes === 0) {
          // No nodes assigned but none available = not supported
          console.warn('📱 Pitch effects not supported on this device/browser')
          pitchBtn.title = 'Pitch effects not supported on this device'
          pitchBtn.style.backgroundColor = '#666'
        } else {
          // Some nodes assigned = just full
          console.warn('All pitch nodes in use')
          pitchBtn.title = `No pitch nodes available (${nodePool.getAvailablePitchCount()}/8)`
          pitchBtn.style.backgroundColor = '#ff6b6b'
        }

        setTimeout(() => {
          pitchBtn.style.backgroundColor = ''
        }, 200)
      }
    })
  }

  // Consolidated Delay button
  const delayBtn = document.getElementById('delayBtn')
  if (delayBtn) {
    delayBtn.addEventListener('click', () => {
      const nodePool = getNodePool()
      const audioScheduler = getAudioScheduler()

      // Check if delay worklets are supported at all
      if (!audioScheduler.isAudioInitialized()) {
        console.warn('Audio not initialized yet')
        delayBtn.style.backgroundColor = '#ff9f40'
        setTimeout(() => {
          delayBtn.style.backgroundColor = ''
        }, 1000)
        return
      }

      if (nodePool.getAvailableDelayCount() > 0) {
        enterParameterControl('delay', 'Delay Settings', '')
      } else {
        console.warn('No delay nodes available')
        // Check if it's a fundamental support issue vs just no available nodes
        const totalDelayNodes = 8 // We always create 8 delay nodes if supported
        const assignedNodes = totalDelayNodes - nodePool.getAvailableDelayCount()

        if (assignedNodes === 0) {
          // No nodes assigned but none available = not supported
          console.warn('📱 Delay effects not supported on this device/browser')
          delayBtn.title = 'Delay effects not supported on this device'
          delayBtn.style.backgroundColor = '#666'
        } else {
          // Some nodes assigned = just full
          console.warn('All delay nodes in use')
          delayBtn.title = `No delay nodes available (${nodePool.getAvailableDelayCount()}/8)`
          delayBtn.style.backgroundColor = '#ff6b6b'
        }

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

  // Master Pitch button
  const masterPitchBtn = document.getElementById('masterPitchBtn')
  if (masterPitchBtn) {
    masterPitchBtn.addEventListener('click', () => {
      enterMasterParameterControl('pitch', 'Master Pitch Shift', 'x')
    })
  }
}

export function enterCellSelectionMode(): void {
  console.log(`📥 enterCellSelectionMode() called`)
  console.log(`📊 State before: mode=${controlState.mode}, isActive=${controlState.isActive}`)

  // Ensure clean state transition
  controlState.mode = 'cellSelection'
  controlState.isActive = true
  controlState.controlledCellIndex = null
  controlState.currentParameter = null

  // Ensure initial controls are shown
  showInitialControls()

  // Update control button visual
  const controlBtn = document.getElementById('controlBtn')
  if (controlBtn) {
    controlBtn.classList.add('active')
    console.log('✅ Control button activated - entering cell selection mode')
  } else {
    console.error('❌ Control button not found when trying to activate')
  }

  console.log(`📊 State after: mode=${controlState.mode}, isActive=${controlState.isActive}`)
  console.log('Control mode: Select a cell to control')
}

export function selectCellForControl(index: number): void {
  const gridCells = getGridCells()

  // Clear previous controlled cell
  if (controlState.controlledCellIndex !== null) {
    const prevCell = gridCells[controlState.controlledCellIndex]?.element
    if (prevCell) {
      prevCell.classList.remove('controlled')
    }
  }

  // Set new controlled cell
  controlState.controlledCellIndex = index
  const cell = gridCells[index]?.element
  if (cell) {
    cell.classList.add('controlled')
  }

  // Switch to cell selected controls
  showCellSelectedControls()

  console.log(`Cell ${index} selected for control: ${gridCells[index]?.stem?.name}`)
}

export function returnToInitialControlState(): void {
  console.log(`📤 returnToInitialControlState() called`)
  console.log(`📊 State before: mode=${controlState.mode}, isActive=${controlState.isActive}`)

  const gridCells = getGridCells()

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

  // Remove active state from control button
  const controlBtn = document.getElementById('controlBtn')
  if (controlBtn) {
    controlBtn.classList.remove('active')
    console.log('✅ Control button deactivated - returning to initial state')
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

export function updateControlsAvailability(): void {
  const nodePool = getNodePool()
  const filterBtn = document.getElementById('filterBtn')
  const delayBtn = document.getElementById('delayBtn')
  const pitchBtn = document.getElementById('pitchBtn')

  if (filterBtn && nodePool) {
    const filterAvailable = nodePool.getAvailableFilterCount() > 0
    filterBtn.style.opacity = filterAvailable ? '1' : '0.3'
    filterBtn.style.pointerEvents = filterAvailable ? 'auto' : 'none'
    filterBtn.title = filterAvailable ? '' : `No filter nodes available (${nodePool.getAvailableFilterCount()}/8)`
  }

  if (delayBtn && nodePool) {
    const delayAvailable = nodePool.getAvailableDelayCount() > 0
    delayBtn.style.opacity = delayAvailable ? '1' : '0.3'
    delayBtn.style.pointerEvents = delayAvailable ? 'auto' : 'none'
    delayBtn.title = delayAvailable ? '' : `No delay nodes available (${nodePool.getAvailableDelayCount()}/8)`
  }

  if (pitchBtn && nodePool) {
    const pitchAvailable = nodePool.getAvailablePitchCount() > 0
    pitchBtn.style.opacity = pitchAvailable ? '1' : '0.3'
    pitchBtn.style.pointerEvents = pitchAvailable ? 'auto' : 'none'
    pitchBtn.title = pitchAvailable ? '' : `No pitch nodes available (${nodePool.getAvailablePitchCount()}/8)`
  }
}

function enterParameterControl(parameter: string, label: string, unit: string): void {
  if (controlState.controlledCellIndex === null) return

  controlState.mode = 'parameterControl'
  controlState.currentParameter = parameter

  // Hide cell selected controls, show parameter control
  const cellSelectedControls = document.getElementById('cellSelectedControls')
  const parameterControl = document.getElementById('parameterControl')

  if (cellSelectedControls) cellSelectedControls.style.display = 'none'
  if (parameterControl) parameterControl.style.display = 'flex'

  // Get references to all control groups
  const loopFractionControl = document.getElementById('loopFractionControl')
  const sliderControl = document.getElementById('sliderControl')
  const delaySettingsControl = document.getElementById('delaySettingsControl')

  // Hide all by default
  if (loopFractionControl) loopFractionControl.style.display = 'none'
  if (sliderControl) sliderControl.style.display = 'none'
  if (delaySettingsControl) delaySettingsControl.style.display = 'none'

  if (parameter === 'loopFraction') {
    if (loopFractionControl) loopFractionControl.style.display = 'flex'
    const cellParams = getCellParameters(controlState.controlledCellIndex)
    updateLoopFractionButtons(cellParams.loopFraction)

  } else if (parameter === 'delay') {
    if (delaySettingsControl) delaySettingsControl.style.display = 'flex'
    controlState.currentParameter = 'delay'

    const cellParams = getCellParameters(controlState.controlledCellIndex)

    // Initialize with current preset index
    currentDelayPresetIndex = 0
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

    updateDelayTimeControl(cellParams.delayTime)

    // Setup Delay Feedback
    const delayFeedbackSlider = document.getElementById('delayFeedbackSlider') as HTMLInputElement
    const delayFeedbackParameterValue = document.getElementById('delayFeedbackParameterValue')
    if (delayFeedbackSlider && delayFeedbackParameterValue) {
      const currentDelayFeedback = Math.round(cellParams.delayFeedback * 100)
      delayFeedbackSlider.value = currentDelayFeedback.toString()
      delayFeedbackParameterValue.textContent = `${currentDelayFeedback}%`
    }

  } else if (parameter === 'pitch') {
    // Pitch uses generic slider control like filter
    if (sliderControl) sliderControl.style.display = 'flex'
    controlState.currentParameter = 'pitch'

    const sliderParameterLabel = document.getElementById('sliderParameterLabel')
    if (sliderParameterLabel) sliderParameterLabel.textContent = label

    const parameterSlider = document.getElementById('parameterSlider') as HTMLInputElement
    const sliderParameterValue = document.getElementById('sliderParameterValue')

    if (parameterSlider && sliderParameterValue) {
      const cellParams = getCellParameters(controlState.controlledCellIndex)
      let currentValue = cellParams.pitchRatio

      parameterSlider.min = '-100'
      parameterSlider.max = '100'
      // Map pitch ratio (0.25-4) to slider (-100 to 100)
      // 1.0 = 0, 0.25 = -100, 4.0 = 100
      if (currentValue <= 1) {
        // Map 0.25-1.0 to -100-0
        currentValue = ((currentValue - 0.25) / (1 - 0.25)) * 100 - 100
      } else {
        // Map 1.0-4.0 to 0-100
        currentValue = ((currentValue - 1) / (4 - 1)) * 100
      }
      parameterSlider.value = Math.round(currentValue).toString()

      const pitchRatio = cellParams.pitchRatio
      if (Math.abs(pitchRatio - 1) < 0.01) {
        sliderParameterValue.textContent = 'Normal Pitch'
      } else {
        sliderParameterValue.textContent = `${pitchRatio.toFixed(2)}${unit}`
      }
    }

  } else {
    // Generic slider case (volume, filter, pitch)
    if (sliderControl) sliderControl.style.display = 'flex'
    controlState.currentParameter = parameter

    const sliderParameterLabel = document.getElementById('sliderParameterLabel')
    if (sliderParameterLabel) sliderParameterLabel.textContent = label

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

          if (currentValue > 0) {
            sliderParameterValue.textContent = `High-pass ${currentValue}%`
          } else if (currentValue < 0) {
            sliderParameterValue.textContent = `Low-pass ${Math.abs(currentValue)}%`
          } else {
            sliderParameterValue.textContent = 'No Filter'
          }
          break
        case 'pitch':
          parameterSlider.min = '-100'
          parameterSlider.max = '100'
          // Map pitch ratio (0.25-4) to slider (-100 to 100)
          // 1.0 = 0, 0.25 = -100, 4.0 = 100
          if (currentValue <= 1) {
            // Map 0.25-1.0 to -100-0
            currentValue = ((currentValue - 0.25) / (1 - 0.25)) * 100 - 100
          } else {
            // Map 1.0-4.0 to 0-100
            currentValue = ((currentValue - 1) / (4 - 1)) * 100
          }
          parameterSlider.value = Math.round(currentValue).toString()

          const pitchRatio = cellParams.pitchRatio
          if (Math.abs(pitchRatio - 1) < 0.01) {
            sliderParameterValue.textContent = 'Normal Pitch'
          } else {
            sliderParameterValue.textContent = `${pitchRatio.toFixed(2)}${unit}`
          }
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
    if (Math.abs(btnFraction - currentFraction) < 0.0001) {
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
    const displayValue = Math.round(delayTime * 100)
    delayTimeSlider.value = displayValue.toString()

    const exponentialValue = Math.pow(delayTime, 3)
    const delayTimeMs = 0.1 + (exponentialValue * 1999.9)
    delayParameterValue.textContent = `${delayTimeMs.toFixed(1)}ms`
  }
}

function handleDelayTimeChange(sliderValue: number): void {
  // Handle master effects
  if (controlState.currentParameter?.startsWith('master_')) {
    const normalizedValue = sliderValue / 100
    const exponentialValue = Math.pow(normalizedValue, 3)

    setMasterEffectParameter('delayTime', exponentialValue)

    const delayTimeMs = 0.1 + (exponentialValue * 1999.9)

    const delayParameterValue = document.getElementById('delayParameterValue')
    if (delayParameterValue) {
      delayParameterValue.textContent = `${delayTimeMs.toFixed(1)}ms`
    }

    console.log(`🎛️ Master Delay time: slider=${sliderValue}%, exponential=${exponentialValue.toFixed(3)}, ms=${delayTimeMs.toFixed(1)}`)
    return
  }

  // Handle individual cell effects
  if (controlState.controlledCellIndex === null) return

  const normalizedValue = sliderValue / 100
  const exponentialValue = Math.pow(normalizedValue, 3)

  setCellParameter(controlState.controlledCellIndex, 'delayTime', exponentialValue)

  const delayTimeMs = 0.1 + (exponentialValue * 1999.9)

  const delayParameterValue = document.getElementById('delayParameterValue')
  if (delayParameterValue) {
    delayParameterValue.textContent = `${delayTimeMs.toFixed(1)}ms`
  }

  console.log(`🕐 Delay time: slider=${sliderValue}%, exponential=${exponentialValue.toFixed(3)}, ms=${delayTimeMs.toFixed(1)}`)
}

function handleDelayWetChange(sliderValue: number): void {
  // Handle master effects
  if (controlState.currentParameter?.startsWith('master_')) {
    const actualValue = sliderValue / 100

    setMasterEffectParameter('delayWet', actualValue)

    const delayWetParameterValue = document.getElementById('delayWetParameterValue')
    if (delayWetParameterValue) {
      delayWetParameterValue.textContent = `${sliderValue}%`
    }

    console.log(`🎛️ Master Delay wet: ${sliderValue}%`)
    return
  }

  // Handle individual cell effects
  if (controlState.controlledCellIndex === null) return

  const actualValue = sliderValue / 100

  setCellParameter(controlState.controlledCellIndex, 'delayWet', actualValue)

  const delayWetParameterValue = document.getElementById('delayWetParameterValue')
  if (delayWetParameterValue) {
    delayWetParameterValue.textContent = `${sliderValue}%`
  }
}

function handleDelayFeedbackChange(sliderValue: number): void {
  // Handle master effects
  if (controlState.currentParameter?.startsWith('master_')) {
    const cappedSliderValue = Math.min(90, Math.max(0, sliderValue))
    const actualValue = cappedSliderValue / 100

    setMasterEffectParameter('delayFeedback', actualValue)

    const delayFeedbackParameterValue = document.getElementById('delayFeedbackParameterValue')
    if (delayFeedbackParameterValue) {
      delayFeedbackParameterValue.textContent = `${cappedSliderValue}%`
    }

    console.log(`🎛️ Master Delay feedback: ${cappedSliderValue}%`)
    return
  }

  // Handle individual cell effects
  if (controlState.controlledCellIndex === null) return

  const cappedSliderValue = Math.min(90, Math.max(0, sliderValue))
  const actualValue = cappedSliderValue / 100

  setCellParameter(controlState.controlledCellIndex, 'delayFeedback', actualValue)

  const delayFeedbackParameterValue = document.getElementById('delayFeedbackParameterValue')
  if (delayFeedbackParameterValue) {
    delayFeedbackParameterValue.textContent = `${cappedSliderValue}%`
  }
}

function handlePitchChange(sliderValue: number): void {
  // Handle master effects
  if (controlState.currentParameter?.startsWith('master_')) {
    // Convert slider value (-100 to 100) to pitch ratio (0.25 to 4)
    let actualValue: number
    if (sliderValue <= 0) {
      // Map -100-0 to 0.25-1.0
      actualValue = 0.25 + ((sliderValue + 100) / 100) * (1 - 0.25)
    } else {
      // Map 0-100 to 1.0-4.0
      actualValue = 1 + (sliderValue / 100) * (4 - 1)
    }

    setMasterEffectParameter('pitchRatio', actualValue)

    const pitchParameterValue = document.getElementById('pitchParameterValue')
    if (pitchParameterValue) {
      if (Math.abs(actualValue - 1) < 0.01) {
        pitchParameterValue.textContent = 'Normal Pitch'
      } else {
        pitchParameterValue.textContent = `${actualValue.toFixed(2)}x`
      }
    }

    console.log(`🎛️ Master Pitch ratio: ${actualValue.toFixed(2)}x`)
    return
  }

  // Handle individual cell effects
  if (controlState.controlledCellIndex === null) return

  // Convert slider value (-100 to 100) to pitch ratio (0.25 to 4)
  let actualValue: number
  if (sliderValue <= 0) {
    // Map -100-0 to 0.25-1.0
    actualValue = 0.25 + ((sliderValue + 100) / 100) * (1 - 0.25)
  } else {
    // Map 0-100 to 1.0-4.0
    actualValue = 1 + (sliderValue / 100) * (4 - 1)
  }

  setCellParameter(controlState.controlledCellIndex, 'pitchRatio', actualValue)

  const pitchParameterValue = document.getElementById('pitchParameterValue')
  if (pitchParameterValue) {
    if (Math.abs(actualValue - 1) < 0.01) {
      pitchParameterValue.textContent = 'Normal Pitch'
    } else {
      pitchParameterValue.textContent = `${actualValue.toFixed(2)}x`
    }
  }

  console.log(`🎵 Pitch ratio: ${actualValue.toFixed(2)}x for cell ${controlState.controlledCellIndex}`)
}

function handleParameterChange(sliderValue: number): void {
  // Handle master effects
  if (controlState.currentParameter?.startsWith('master_')) {
    const masterParameter = controlState.currentParameter.replace('master_', '') as keyof MasterEffectParameters

    let actualValue = sliderValue
    let displayText = ''

    // Convert slider value to actual parameter value
    if (masterParameter === 'filter') {
      actualValue = sliderValue / 100
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

    else if (masterParameter === 'pitchRatio') {
      // Convert slider value (-100 to 100) to pitch ratio (0.25 to 4)
      if (sliderValue <= 0) {
        // Map -100-0 to 0.25-1.0
        actualValue = 0.25 + ((sliderValue + 100) / 100) * (1 - 0.25)
      } else {
        // Map 0-100 to 1.0-4.0
        actualValue = 1 + (sliderValue / 100) * (4 - 1)
      }

      if (Math.abs(actualValue - 1) < 0.01) {
        displayText = 'Normal Pitch'
      } else {
        displayText = `${actualValue.toFixed(2)}x`
      }
    }

    setMasterEffectParameter(masterParameter, actualValue)

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
      actualValue = sliderValue / 100
      displayValue = sliderValue
      unit = '%'
      displayText = `${displayValue}${unit}`
      break
    case 'filter':
      actualValue = sliderValue / 100
      if (sliderValue > 0) {
        displayText = `High-pass ${sliderValue}%`
      } else if (sliderValue < 0) {
        displayText = `Low-pass ${Math.abs(sliderValue)}%`
      } else {
        displayText = 'No Filter'
      }
      break
    case 'pitch':
      // Convert slider value (-100 to 100) to pitch ratio (0.25 to 4)
      if (sliderValue <= 0) {
        // Map -100-0 to 0.25-1.0
        actualValue = 0.25 + ((sliderValue + 100) / 100) * (1 - 0.25)
      } else {
        // Map 0-100 to 1.0-4.0
        actualValue = 1 + (sliderValue / 100) * (4 - 1)
      }

      if (Math.abs(actualValue - 1) < 0.01) {
        displayText = 'Normal Pitch'
      } else {
        displayText = `${actualValue.toFixed(2)}x`
      }
      break
  }

  setCellParameter(
    controlState.controlledCellIndex,
    controlState.currentParameter === 'pitch' ? 'pitchRatio' : controlState.currentParameter as keyof CellParameters,
    actualValue
  )

  const sliderParameterValue = document.getElementById('sliderParameterValue')
  if (sliderParameterValue) {
    sliderParameterValue.textContent = displayText || `${displayValue}${unit}`
  }
}

export function handleLoopFractionChange(fraction: number): void {
  if (controlState.controlledCellIndex === null) return

  setCellParameter(controlState.controlledCellIndex, 'loopFraction', fraction)

  updateLoopFractionButtons(fraction)

  console.log(`🔄 Loop fraction set to ${fraction} for cell ${controlState.controlledCellIndex}`)
}

export function handleBPMDelaySync(fraction: number): void {
  if (controlState.controlledCellIndex === null) return

  const gridCells = getGridCells()
  const cell = gridCells[controlState.controlledCellIndex]
  if (!cell?.stem) return

  const stemBPM = cell.stem.bpm

  // Calculate BPM-synced delay time
  const beatDuration = 60 / stemBPM
  const noteDuration = beatDuration * fraction

  const minDelayMs = 0.1
  const maxDelayMs = 2000
  const delayTimeMs = Math.min(Math.max(noteDuration * 1000, minDelayMs), maxDelayMs)

  const normalizedMs = (delayTimeMs - 0.1) / 1999.9
  const delayTimeValue = Math.pow(normalizedMs, 1 / 3)

  setCellParameter(controlState.controlledCellIndex, 'delayTime', delayTimeValue)

  const delayTimeSlider = document.getElementById('delayTimeSlider') as HTMLInputElement
  const delayParameterValue = document.getElementById('delayParameterValue')

  if (delayTimeSlider && delayParameterValue) {
    const sliderValue = delayTimeValue * 100
    delayTimeSlider.value = Math.round(sliderValue).toString()

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

function navigateDelayPreset(direction: 'prev' | 'next'): void {
  if (direction === 'next') {
    currentDelayPresetIndex = (currentDelayPresetIndex + 1) % delayPresets.length
  } else {
    currentDelayPresetIndex = (currentDelayPresetIndex - 1 + delayPresets.length) % delayPresets.length
  }

  applyDelayPreset(currentDelayPresetIndex)

  const preset = delayPresets[currentDelayPresetIndex]
  const delayParameterValue = document.getElementById('delayParameterValue')
  if (delayParameterValue) {
    delayParameterValue.textContent = `${preset.name}`
    delayParameterValue.style.fontWeight = 'bold'
    delayParameterValue.style.color = '#667eea'

    setTimeout(() => {
      if (controlState.controlledCellIndex !== null) {
        const cellParams = getCellParameters(controlState.controlledCellIndex)
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

function applyDelayPreset(presetIndex: number): void {
  if (controlState.controlledCellIndex === null) return

  const preset = delayPresets[presetIndex]
  if (!preset) return

  const cellIndex = controlState.controlledCellIndex

  let timeValue = preset.time
  if (preset.syncFraction) {
    const gridCells = getGridCells()
    const cell = gridCells[cellIndex]
    if (cell?.stem?.bpm) {
      const audioScheduler = getAudioScheduler()
      timeValue = audioScheduler.calculateBPMDelayTime(preset.syncFraction, cell.stem.bpm)
    }
  }

  setCellParameter(cellIndex, 'delayWet', preset.wet)
  setCellParameter(cellIndex, 'delayFeedback', preset.feedback)
  setCellParameter(cellIndex, 'delayTime', timeValue)

  updateDelayControlsDisplay(preset, timeValue)

  console.log(`Applied delay preset: ${preset.name}`)
}

function updateDelayControlsDisplay(preset: { wet: number; feedback: number; syncFraction?: number }, timeValue: number): void {
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

function setMasterEffectParameter(parameter: keyof MasterEffectParameters, value: number): void {
  if (parameter === 'delayFeedback') {
    value = Math.min(0.90, Math.max(0, value))
  }

  else if (parameter === 'delayWet') {
    value = Math.min(1, Math.max(0, value))
  }

  else if (parameter === 'pitchRatio') {
    value = Math.min(4, Math.max(0.25, value))
  }

  masterEffectParameters[parameter] = value

  const audioScheduler = getAudioScheduler()

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

    else if (parameter === 'pitchRatio') {
      audioScheduler.updateMasterPitchParameter(value)
    }
  }
}

function enterMasterEffectsMode(): void {
  console.log('🎛️ Entering master effects mode')

  controlState.mode = 'masterEffects'
  controlState.isActive = true
  controlState.controlledCellIndex = null
  controlState.currentParameter = null

  const initialControls = document.getElementById('initialControls')
  const cellSelectedControls = document.getElementById('cellSelectedControls')
  const parameterControl = document.getElementById('parameterControl')
  const masterEffectsControls = document.getElementById('masterEffectsControls')

  if (initialControls) initialControls.style.display = 'none'
  if (cellSelectedControls) cellSelectedControls.style.display = 'none'
  if (parameterControl) parameterControl.style.display = 'none'
  if (masterEffectsControls) masterEffectsControls.style.display = 'flex'

  const effectBtn = document.getElementById('effectBtn')
  if (effectBtn) effectBtn.classList.add('active')
}

function enterMasterParameterControl(parameter: string, label: string, unit: string): void {
  console.log(`🎛️ Entering master parameter control: ${parameter}`)

  controlState.mode = 'parameterControl'
  controlState.currentParameter = 'master_' + parameter

  const masterEffectsControls = document.getElementById('masterEffectsControls')
  const parameterControl = document.getElementById('parameterControl')

  if (masterEffectsControls) masterEffectsControls.style.display = 'none'
  if (parameterControl) parameterControl.style.display = 'flex'

  const loopFractionControl = document.getElementById('loopFractionControl')
  const sliderControl = document.getElementById('sliderControl')
  const delaySettingsControl = document.getElementById('delaySettingsControl')

  // Hide all by default
  if (loopFractionControl) loopFractionControl.style.display = 'none'
  if (sliderControl) sliderControl.style.display = 'none'
  if (delaySettingsControl) delaySettingsControl.style.display = 'none'

  if (parameter === 'delay') {
    if (delaySettingsControl) delaySettingsControl.style.display = 'flex'

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

  else if (parameter === 'pitch') {
    // Pitch uses generic slider control like filter
    if (sliderControl) sliderControl.style.display = 'flex'
    controlState.currentParameter = 'master_pitchRatio'

    const sliderParameterLabel = document.getElementById('sliderParameterLabel')
    if (sliderParameterLabel) sliderParameterLabel.textContent = label

    const parameterSlider = document.getElementById('parameterSlider') as HTMLInputElement
    const sliderParameterValue = document.getElementById('sliderParameterValue')

    if (parameterSlider && sliderParameterValue) {
      let currentValue = masterEffectParameters.pitchRatio

      parameterSlider.min = '-100'
      parameterSlider.max = '100'
      // Map pitch ratio (0.25-4) to slider (-100 to 100)
      // 1.0 = 0, 0.25 = -100, 4.0 = 100
      if (currentValue <= 1) {
        // Map 0.25-1.0 to -100-0
        currentValue = ((currentValue - 0.25) / (1 - 0.25)) * 100 - 100
      } else {
        // Map 1.0-4.0 to 0-100
        currentValue = ((currentValue - 1) / (4 - 1)) * 100
      }
      parameterSlider.value = Math.round(currentValue).toString()

      const pitchRatio = masterEffectParameters.pitchRatio
      if (Math.abs(pitchRatio - 1) < 0.01) {
        sliderParameterValue.textContent = 'Normal Pitch'
      } else {
        sliderParameterValue.textContent = `${pitchRatio.toFixed(2)}${unit}`
      }
    }

  } else {
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

      else if (parameter === 'pitch') {
        parameterSlider.min = '-100'
        parameterSlider.max = '100'

        // Map pitch ratio (0.25-4) to slider (-100 to 100)
        if (currentValue <= 1) {
          // Map 0.25-1.0 to -100-0
          currentValue = ((currentValue - 0.25) / (1 - 0.25)) * 100 - 100
        } else {
          // Map 1.0-4.0 to 0-100
          currentValue = ((currentValue - 1) / (4 - 1)) * 100
        }

        parameterSlider.value = Math.round(currentValue).toString()

        const pitchRatio = masterEffectParameters.pitchRatio
        if (Math.abs(pitchRatio - 1) < 0.01) {
          sliderParameterValue.textContent = 'Normal Pitch'
        } else {
          sliderParameterValue.textContent = `${pitchRatio.toFixed(2)}${unit}`
        }
      }
    }
  }
}
