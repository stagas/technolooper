import { Delay } from './delay-node.ts'
import { Pitch } from './pitch-node.ts'
import type { Stem, StemCell, CellParameters } from './types.ts'
import { NodePool } from './node-pool.ts'

// Audio Scheduler Class
export class AudioScheduler {
  private audioContext: AudioContext | null = null
  private masterGainNode: GainNode | null = null
  private masterFilterNode: BiquadFilterNode | null = null
  private masterDelayNode: AudioWorkletNode | null = null
  private masterDelayParams: { delay: AudioParam | undefined; feedback: AudioParam | undefined } = { delay: undefined, feedback: undefined }
  private masterDelayWetNode: GainNode | null = null
  private masterDelayDryNode: GainNode | null = null
  private masterPitchNode: AudioWorkletNode | null = null
  private masterPitchRatio: AudioParam | undefined = undefined
  private isDelayReady = false // Track if delay worklet is registered
  private isPitchReady = false // Track if pitch worklet is registered
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
    pitchNode: AudioWorkletNode // PitchNode instance
    pitchRatio: AudioParam | undefined // Pitch ratio parameter
    stem: Stem
    currentLoopFraction: number
  }> = new Map()
  private isInitialized = false
  private fadeTime = 0.005 // 5ms fade in/out - very quick to avoid clicks
  private masterBPM = 120 // Default BPM, will be updated from stems
  private beatsPerBar = 4 // 4/4 time signature
  private barDuration = 0 // Calculated from BPM
  private nodePool: NodePool

  constructor(nodePool: NodePool) {
    this.nodePool = nodePool
  }

  async initializeAudio(): Promise<void> {
    if (this.isInitialized) return

    try {
      // Create audio context with better mobile support
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
      this.masterGainNode = this.audioContext.createGain()

      // Create master effect nodes
      this.masterFilterNode = this.audioContext.createBiquadFilter()
      this.masterFilterNode.type = 'allpass' // Start with no filter

      // Create master delay nodes
      this.masterDelayWetNode = this.audioContext.createGain()
      this.masterDelayDryNode = this.audioContext.createGain()
      this.masterDelayWetNode.gain.setValueAtTime(0, this.audioContext.currentTime) // Start with no delay wet
      this.masterDelayDryNode.gain.setValueAtTime(1, this.audioContext.currentTime) // Full dry by default

      // Resume context if suspended (critical for mobile)
      if (this.audioContext.state === 'suspended') {
        console.log('📱 Audio context suspended, attempting to resume...')
        await this.audioContext.resume()
        console.log(`📱 Audio context resumed, state: ${this.audioContext.state}`)
      }

      // Double-check audio context state
      if (this.audioContext.state !== 'running') {
        console.warn(`⚠️ Audio context not running after resume attempt, state: ${this.audioContext.state}`)
      }

      // Check if AudioWorklet is supported (critical for delay/pitch effects)
      if (!this.audioContext.audioWorklet) {
        console.warn('⚠️ AudioWorklet not supported on this browser - delay and pitch effects will be disabled')
        // Set flags to indicate worklets are not available
        this.isDelayReady = false
        this.isPitchReady = false
      } else {
        // Initialize DelayNode worklet registration once
        console.log('📱 Initializing DelayNode worklet...')
        try {
          const testDelay = await Delay(this.audioContext)
          this.isDelayReady = true
          // Disconnect the test delay node as we just needed it for worklet registration
          testDelay.node.disconnect()
          console.log('📱 DelayNode worklet ready')
        } catch (error) {
          console.warn('⚠️ DelayNode worklet failed to initialize:', error)
          this.isDelayReady = false
          // Check for specific mobile/browser compatibility issues
          if (error instanceof Error) {
            if (error.message.includes('AudioWorklet') || error.message.includes('worklet')) {
              console.warn('📱 DelayNode AudioWorklet not properly supported on this browser')
            } else if (error.message.includes('fetch') || error.message.includes('network')) {
              console.warn('📱 DelayNode failed to load worklet files - network issue')
            } else if (error.message.includes('addModule')) {
              console.warn('📱 DelayNode worklet module failed to load - likely mobile browser limitation')
            } else if (error.message.includes('register')) {
              console.warn('📱 DelayNode processor registration failed - worklet not supported')
            }
          }
        }

        // Initialize PitchNode worklet registration once
        console.log('📱 Initializing PitchNode worklet...')
        try {
          const testPitch = await Pitch(this.audioContext)
          this.isPitchReady = true
          // Disconnect the test pitch node as we just needed it for worklet registration
          testPitch.node.disconnect()
          console.log('📱 PitchNode worklet ready')
        } catch (error) {
          console.warn('⚠️ PitchNode worklet failed to initialize:', error)
          this.isPitchReady = false
          // Check for specific mobile/browser compatibility issues
          if (error instanceof Error) {
            if (error.message.includes('WebAssembly') || error.message.includes('wasm')) {
              console.warn('📱 PitchNode requires WebAssembly - not supported on this browser')
            } else if (error.message.includes('AudioWorklet') || error.message.includes('worklet')) {
              console.warn('📱 PitchNode AudioWorklet not properly supported on this browser')
            } else if (error.message.includes('fetch') || error.message.includes('network')) {
              console.warn('📱 PitchNode failed to load worklet files - network issue')
            }
          }
        }
      }

      // Only create master delay/pitch nodes if worklets are ready
      if (this.isDelayReady) {
        // Create master delay node after worklet is ready
        try {
          const masterDelay = await Delay(this.audioContext)
          this.masterDelayNode = masterDelay.node
          this.masterDelayParams = {
            delay: masterDelay.delay,
            feedback: masterDelay.feedback
          }
          console.log('📱 Master delay node created successfully')
        } catch (error) {
          console.warn('⚠️ Failed to create master delay node:', error)
          this.isDelayReady = false
          this.masterDelayNode = null
          this.masterDelayParams = { delay: undefined, feedback: undefined }
          console.warn('📱 Master delay disabled due to creation failure')
        }
      } else {
        console.warn('📱 Master delay disabled - worklet not available')
      }

      if (this.isPitchReady) {
        // Create master pitch node after worklet is ready
        const masterPitch = await Pitch(this.audioContext)
        this.masterPitchNode = masterPitch.node
        this.masterPitchRatio = masterPitch.pitchRatio
      } else {
        console.warn('📱 Master pitch disabled - worklet not available')
      }

      // Set up master audio chain based on what's available
      this.setupMasterAudioChain()

      // Initialize node pools
      console.log('📱 Initializing node pools...')
      await this.nodePool.initialize(this.audioContext)

      // Log pool status
      console.log(`📱 Node pools initialized: Delay ${this.nodePool.getAvailableDelayCount()}/8, Filter ${this.nodePool.getAvailableFilterCount()}/8, Pitch ${this.nodePool.getAvailablePitchCount()}/8`)

      // Initialize master pitch to bypass mode (ratio 1.0) if available
      if (this.isPitchReady) {
        this.updateMasterPitchParameter(1.0)
      }

      this.updateBarDuration()
      this.isInitialized = true

      console.log('📱 Audio scheduler initialized successfully')
    } catch (error) {
      console.error('Failed to initialize audio:', error)
      if (error instanceof Error) {
        console.error('Error details:', error.stack)
      }
    }
  }

  private setupMasterAudioChain(): void {
    if (!this.audioContext || !this.masterGainNode || !this.masterFilterNode) return

    // Basic chain: masterGain -> masterFilter
    this.masterGainNode.connect(this.masterFilterNode)

    if (this.masterPitchNode) {
      // With pitch: filter -> pitch -> delays -> destination
      this.masterFilterNode.connect(this.masterPitchNode)

      if (this.masterDelayNode && this.masterDelayWetNode && this.masterDelayDryNode) {
        // Full chain with delay
        this.masterPitchNode.connect(this.masterDelayDryNode)
        this.masterPitchNode.connect(this.masterDelayNode)
        this.masterDelayDryNode.connect(this.audioContext.destination)
        this.masterDelayNode.connect(this.masterDelayWetNode)
        this.masterDelayWetNode.connect(this.audioContext.destination)
      } else {
        // Just pitch, no delay
        this.masterPitchNode.connect(this.audioContext.destination)
      }
    } else if (this.masterDelayNode && this.masterDelayWetNode && this.masterDelayDryNode) {
      // No pitch, but with delay: filter -> delays -> destination
      this.masterFilterNode.connect(this.masterDelayDryNode)
      this.masterFilterNode.connect(this.masterDelayNode)
      this.masterDelayDryNode.connect(this.audioContext.destination)
      this.masterDelayNode.connect(this.masterDelayWetNode)
      this.masterDelayWetNode.connect(this.audioContext.destination)
    } else {
      // Basic chain only: filter -> destination
      this.masterFilterNode.connect(this.audioContext.destination)
    }

    console.log(`📱 Master audio chain setup complete: Pitch=${!!this.masterPitchNode}, Delay=${!!this.masterDelayNode}`)
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
      console.log('📱 Resuming suspended audio context...')
      await this.audioContext.resume()
      console.log(`📱 Audio context state after resume: ${this.audioContext.state}`)
    }

    // For mobile browsers, sometimes we need to create a dummy sound
    if (this.audioContext && this.audioContext.state === 'running') {
      try {
        // Create and play a silent buffer to unlock audio on mobile
        const silentBuffer = this.audioContext.createBuffer(1, 1, this.audioContext.sampleRate)
        const silentSource = this.audioContext.createBufferSource()
        silentSource.buffer = silentBuffer
        silentSource.connect(this.audioContext.destination)
        silentSource.start()
        silentSource.stop(this.audioContext.currentTime + 0.001)
        console.log('📱 Silent buffer played to unlock mobile audio')
      } catch (error) {
        console.warn('📱 Could not play silent buffer:', error)
      }
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

  async addStem(cellIndex: number, stem: Stem, getCellParameters: (index: number) => CellParameters): Promise<void> {
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

      // Get cell parameters to check if we need delay/filter/pitch
      const params = getCellParameters(cellIndex)

      // Try to get pooled nodes if they're needed
      let pooledDelayNode = null
      let pooledFilterNode = null
      let pooledPitchNode = null

      if (params.filter !== 0) {
        pooledFilterNode = this.nodePool.assignFilterNode(cellIndex)
        if (!pooledFilterNode) {
          console.warn(`No available filter nodes for cell ${cellIndex}`)
        }
      }

      if (Math.abs(params.pitchRatio - 1) > 0.001) {
        pooledPitchNode = this.nodePool.assignPitchNode(cellIndex)
        if (!pooledPitchNode) {
          console.warn(`No available pitch nodes for cell ${cellIndex}`)
        } else {
          // Test if the pitch node is actually working
          try {
            if (pooledPitchNode.pitchRatio) {
              // Try to set a test value to ensure the parameter is working
              pooledPitchNode.pitchRatio.setValueAtTime(1.0, this.audioContext.currentTime)
            } else {
              console.warn(`Pitch node parameter not available for cell ${cellIndex}`)
              this.nodePool.releasePitchNode(cellIndex)
              pooledPitchNode = null
            }
          } catch (error) {
            console.warn(`Pitch node test failed for cell ${cellIndex}:`, error)
            this.nodePool.releasePitchNode(cellIndex)
            pooledPitchNode = null
          }
        }
      }

      if (params.delayWet > 0) {
        pooledDelayNode = this.nodePool.assignDelayNode(cellIndex)
        if (!pooledDelayNode) {
          console.warn(`No available delay nodes for cell ${cellIndex}`)
        } else {
          // Test if the delay node is actually working
          try {
            if (pooledDelayNode.delayParams.delay && pooledDelayNode.delayParams.feedback) {
              // Try to set test values to ensure the parameters are working
              pooledDelayNode.delayParams.delay.setValueAtTime(0, this.audioContext.currentTime)
              pooledDelayNode.delayParams.feedback.setValueAtTime(0, this.audioContext.currentTime)
            } else {
              console.warn(`Delay node parameters not available for cell ${cellIndex}`)
              this.nodePool.releaseDelayNode(cellIndex)
              pooledDelayNode = null
            }
          } catch (error) {
            console.warn(`Delay node test failed for cell ${cellIndex}:`, error)
            this.nodePool.releaseDelayNode(cellIndex)
            pooledDelayNode = null
          }
        }
      }

      // Set up audio chain
      let audioChainEnd: AudioNode = source

      // Add pitch if available
      if (pooledPitchNode) {
        audioChainEnd.connect(pooledPitchNode.pitchNode)
        audioChainEnd = pooledPitchNode.pitchNode
      }

      // Add filter if available
      if (pooledFilterNode) {
        audioChainEnd.connect(pooledFilterNode.filterNode)
        audioChainEnd = pooledFilterNode.filterNode
      }

      // Add delay if available
      if (pooledDelayNode) {
        // Connect chain end to both dry and delay paths
        audioChainEnd.connect(pooledDelayNode.delayDryNode)
        audioChainEnd.connect(pooledDelayNode.delayNode)
        pooledDelayNode.delayNode.connect(pooledDelayNode.delayWetNode)

        // Create a mixer for wet/dry signals
        const mixerNode = this.audioContext.createGain()
        pooledDelayNode.delayDryNode.connect(mixerNode)
        pooledDelayNode.delayWetNode.connect(mixerNode)

        audioChainEnd = mixerNode
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
        pitchNode: pooledPitchNode?.pitchNode || null as any, // Will be null if no pooled node
        pitchRatio: pooledPitchNode?.pitchRatio || undefined,
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

    // Apply pitch settings
    this.applyPitchParameter(sourceInfo, params.pitchRatio)
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
    if (!this.audioContext) return

    // Check if delay nodes are available and working
    if (!sourceInfo.delayParams || !sourceInfo.delayParams.delay || !sourceInfo.delayParams.feedback) {
      console.warn(`🔄 Delay node not available for this source - skipping delay changes`)
      return
    }

    try {
      // Calculate delay time in seconds with exponential mapping
      // 0-1 maps to 0.1ms-2000ms exponentially for flanger to long delay
      const exponentialValue = Math.pow(delayTime, 3) // Cubic curve for more room at small values
      const delayTimeMs = 0.1 + (exponentialValue * 1999.9) // 0.1ms to 2000ms
      const delayTimeSeconds = delayTimeMs / 1000

      // Apply delay time to the DelayNode
      sourceInfo.delayParams.delay.setValueAtTime(delayTimeSeconds, this.audioContext.currentTime)

      // Apply feedback to the DelayNode
      // feedbackAmount is 0-1 from slider, DelayNode expects 0-0.95
      sourceInfo.delayParams.feedback.setValueAtTime(Math.min(0.95, feedbackAmount), this.audioContext.currentTime)

      // Apply wet/dry mix (Dry is always 100%, Wet controls the amount of delayed signal)
      sourceInfo.delayWetNode.gain.setValueAtTime(wetAmount, this.audioContext.currentTime)
      sourceInfo.delayDryNode.gain.setValueAtTime(1, this.audioContext.currentTime)

      console.log(`🔄 DelayNode: ${delayTimeMs.toFixed(1)}ms, Wet: ${(wetAmount * 100).toFixed(0)}%, Dry: 100%, Feedback: ${(Math.min(0.95, feedbackAmount) * 100).toFixed(0)}%`)
    } catch (error) {
      console.warn(`🔄 Failed to apply delay parameters:`, error)
      // On mobile/unsupported browsers, we might need to gracefully handle this
      if (error instanceof Error && error.message.includes('InvalidStateError')) {
        console.warn(`🔄 Delay worklet not properly initialized - this is common on mobile browsers`)
      }
    }
  }

  private applyPitchParameter(sourceInfo: any, pitchRatio: number): void {
    if (!this.audioContext) return

    // Check if pitch node is available and working
    if (!sourceInfo.pitchRatio) {
      console.warn(`🎵 Pitch node not available for this source - skipping pitch change to ${pitchRatio.toFixed(2)}x`)
      return
    }

    try {
      // Apply pitch ratio directly to the PitchNode
      sourceInfo.pitchRatio.setValueAtTime(pitchRatio, this.audioContext.currentTime)
      console.log(`🎵 Pitch ratio: ${pitchRatio.toFixed(2)}x`)
    } catch (error) {
      console.warn(`🎵 Failed to apply pitch ratio ${pitchRatio.toFixed(2)}x:`, error)
      // On mobile/unsupported browsers, we might need to gracefully handle this
      if (error instanceof Error && error.message.includes('InvalidStateError')) {
        console.warn(`🎵 Pitch worklet not properly initialized - this is common on mobile browsers`)
      }
    }
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

  updateCellParameter(cellIndex: number, parameter: keyof CellParameters, value: number, getCellParameters: (index: number) => CellParameters, setCellParameter: (index: number, param: keyof CellParameters, val: number) => void): void {
    const sourceInfo = this.activeSources.get(cellIndex)
    if (!sourceInfo || !this.audioContext) return

    switch (parameter) {
      case 'loopFraction':
        // For loop changes, we need to restart the source on the next beat
        if (this.isPlaying && sourceInfo.currentLoopFraction !== value) {
          this.scheduleLoopFractionChange(cellIndex, value, setCellParameter)
        } else if (!this.isPlaying) {
          // If not playing, apply immediately
          this.applyLoopFractionChange(cellIndex, value, setCellParameter)
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
      case 'pitchRatio':
        // Apply pitch ratio immediately
        this.applyPitchParameter(sourceInfo, value)
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

  private scheduleLoopFractionChange(cellIndex: number, newFraction: number, setCellParameter: (index: number, param: keyof CellParameters, val: number) => void): void {
    if (!this.audioContext) return

    const nextBeatTime = this.getNextBeatTime()
    const timeToNextBeat = nextBeatTime - this.audioContext.currentTime

    console.log(`🎵 Scheduling loop fraction change to ${newFraction} in ${timeToNextBeat.toFixed(3)}s at next beat`)

    // Schedule the change
    setTimeout(() => {
      this.applyLoopFractionChange(cellIndex, newFraction, setCellParameter)
    }, timeToNextBeat * 1000) // Convert to milliseconds
  }

  private async applyLoopFractionChange(cellIndex: number, newFraction: number, setCellParameter: (index: number, param: keyof CellParameters, val: number) => void): Promise<void> {
    const sourceInfo = this.activeSources.get(cellIndex)
    if (!sourceInfo || !this.audioContext) return

    const stem = sourceInfo.stem

    // Update the stored parameter
    setCellParameter(cellIndex, 'loopFraction', newFraction)

    // Apply the loop fraction to the actual playing audio source
    if (sourceInfo.source.buffer) {
      const bufferDuration = sourceInfo.source.buffer.duration
      if (newFraction < 1) {
        const loopEnd = bufferDuration * newFraction
        sourceInfo.source.loopStart = 0
        sourceInfo.source.loopEnd = loopEnd
        sourceInfo.currentLoopFraction = newFraction
        console.log(`🔄 Applied loop end to ${loopEnd.toFixed(3)}s (${newFraction * 100}% of ${bufferDuration.toFixed(3)}s)`)
      } else {
        // Full loop
        sourceInfo.source.loopStart = 0
        sourceInfo.source.loopEnd = bufferDuration
        sourceInfo.currentLoopFraction = 1
        console.log(`🔄 Applied full loop: ${bufferDuration.toFixed(3)}s`)
      }
    }

    console.log(`✅ Applied loop fraction change to ${newFraction} for cell ${cellIndex}`)
  }

  removeStem(cellIndex: number): void {
    const sourceInfo = this.activeSources.get(cellIndex)
    if (!sourceInfo) return

    this.stopSource(cellIndex, sourceInfo)
    this.activeSources.delete(cellIndex)

    // Release pooled nodes
    this.nodePool.releaseDelayNode(cellIndex)
    this.nodePool.releaseFilterNode(cellIndex)
    this.nodePool.releasePitchNode(cellIndex)

    console.log(`Removed stem: ${sourceInfo.stem.name}`)
  }

  async updateActiveStems(activeCells: number[], allCells: StemCell[], getCellParameters: (index: number) => CellParameters): Promise<void> {
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
          await this.addStem(cellIndex, stem, getCellParameters)
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

  updateMasterPitchParameter(pitchRatio: number): void {
    if (!this.audioContext || !this.masterFilterNode || !this.masterDelayDryNode || !this.masterDelayNode || !this.masterDelayWetNode) return

    // Check if we should bypass the pitch node entirely
    if (Math.abs(pitchRatio - 1.0) < 0.001) {
      // Bypass mode - reconnect audio chain without pitch node
      if (this.masterPitchNode) {
        // Disconnect current chain
        this.masterFilterNode.disconnect()
        this.masterPitchNode.disconnect()
        this.masterDelayDryNode.disconnect()
        this.masterDelayNode.disconnect()
        this.masterDelayWetNode.disconnect()

        // Reconnect without pitch: filter -> delay paths -> destination
        this.masterFilterNode.connect(this.masterDelayDryNode)
        this.masterFilterNode.connect(this.masterDelayNode)
        this.masterDelayDryNode.connect(this.audioContext.destination)
        this.masterDelayNode.connect(this.masterDelayWetNode)
        this.masterDelayWetNode.connect(this.audioContext.destination)

        console.log(`🎛️ Master Pitch bypassed (ratio ~1.0)`)
      }
      return
    }

    // Active pitch mode - ensure pitch node is in chain
    if (this.masterPitchNode && this.masterPitchRatio) {
      // Disconnect current chain
      this.masterFilterNode.disconnect()
      this.masterPitchNode.disconnect()
      this.masterDelayDryNode.disconnect()
      this.masterDelayNode.disconnect()
      this.masterDelayWetNode.disconnect()

      // Reconnect with pitch: filter -> pitch -> delay paths -> destination
      this.masterFilterNode.connect(this.masterPitchNode)
      this.masterPitchNode.connect(this.masterDelayDryNode)
      this.masterPitchNode.connect(this.masterDelayNode)
      this.masterDelayDryNode.connect(this.audioContext.destination)
      this.masterDelayNode.connect(this.masterDelayWetNode)
      this.masterDelayWetNode.connect(this.audioContext.destination)

      // Apply the pitch ratio
      this.masterPitchRatio.setValueAtTime(pitchRatio, this.audioContext.currentTime)
      console.log(`🎛️ Master Pitch ratio: ${pitchRatio.toFixed(2)}x`)
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

  // Mobile audio debugging helper
  getMobileAudioStatus(): { isWorking: boolean; state: string; issues: string[] } {
    const issues: string[] = []

    if (!this.audioContext) {
      issues.push('Audio context not created')
      return { isWorking: false, state: 'none', issues }
    }

    if (this.audioContext.state === 'suspended') {
      issues.push('Audio context suspended - needs user interaction')
    }

    if (this.audioContext.state === 'closed') {
      issues.push('Audio context closed')
    }

    if (!this.isInitialized) {
      issues.push('Audio scheduler not initialized')
    }

    const isWorking = this.audioContext.state === 'running' && this.isInitialized

    return {
      isWorking,
      state: this.audioContext.state,
      issues
    }
  }

  // Debug method for troubleshooting mobile audio and node pools
  getFullAudioStatus(): void {
    console.log('🔍 Full Audio Status Debug:')
    console.log(`  Audio Context: ${this.audioContext ? 'Created' : 'Not Created'}`)
    console.log(`  Audio Context State: ${this.audioContext?.state || 'N/A'}`)
    console.log(`  Audio Initialized: ${this.isInitialized}`)
    console.log(`  Master Gain: ${this.masterGainNode ? 'Created' : 'Not Created'}`)
    console.log(`  Master Filter: ${this.masterFilterNode ? 'Created' : 'Not Created'}`)
    console.log(`  Master Delay: ${this.masterDelayNode ? 'Created' : 'Not Created'}`)
    console.log(`  Master Pitch: ${this.masterPitchNode ? 'Created' : 'Not Created'}`)
    console.log(`  Delay Ready: ${this.isDelayReady}`)
    console.log(`  Pitch Ready: ${this.isPitchReady}`)
    console.log(`  AudioWorklet Support: ${this.audioContext?.audioWorklet ? 'Yes' : 'No'}`)

    if (this.nodePool) {
      console.log(`  Pool - Delay: ${this.nodePool.getAvailableDelayCount()}/8 available`)
      console.log(`  Pool - Filter: ${this.nodePool.getAvailableFilterCount()}/8 available`)
      console.log(`  Pool - Pitch: ${this.nodePool.getAvailablePitchCount()}/8 available`)

      // Check if pitch nodes are actually working
      const pitchUnavailable = 8 - this.nodePool.getAvailablePitchCount()
      if (pitchUnavailable === 0 && !this.isPitchReady) {
        console.log(`  🔴 Pitch Issue: No pitch nodes available and worklet not ready (likely mobile/browser incompatibility)`)
      } else if (this.isPitchReady && this.nodePool.getAvailablePitchCount() === 8) {
        console.log(`  ✅ Pitch Status: All nodes available and worklet ready`)
      }
    } else {
      console.log(`  Node Pool: Not Available`)
    }

    console.log(`  Active Sources: ${this.activeSources.size}`)

    // Test for common mobile issues
    if (typeof window !== 'undefined') {
      const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      console.log(`  Mobile Device: ${isMobile ? 'Yes' : 'No'}`)

      if (isMobile && !this.isPitchReady) {
        console.log(`  📱 Mobile Pitch Issue: Pitch effects likely not supported on this mobile browser`)
      }
    }
  }
}
