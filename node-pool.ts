import { Delay } from './delay-node.ts'
import { Pitch } from './pitch-node.ts'
import type { PooledDelayNode, PooledFilterNode, PooledPitchNode } from './types.ts'

// Audio Node Pools System
export class NodePool {
  private delayPool: PooledDelayNode[] = []
  private filterPool: PooledFilterNode[] = []
  private pitchPool: PooledPitchNode[] = []
  private audioContext: AudioContext | null = null

  async initialize(audioContext: AudioContext): Promise<void> {
    this.audioContext = audioContext

    // Initialize delay pool (8 nodes) - only if AudioWorklet is supported
    if (audioContext.audioWorklet) {
      try {
        for (let i = 0; i < 8; i++) {
          try {
            const delayResult = await Delay(audioContext)
            const delayWetNode = audioContext.createGain()
            const delayDryNode = audioContext.createGain()

            delayWetNode.gain.setValueAtTime(0, audioContext.currentTime)
            delayDryNode.gain.setValueAtTime(1, audioContext.currentTime)

            // Test if the delay node is actually working
            if (delayResult.delay && delayResult.feedback) {
              delayResult.delay.setValueAtTime(0, audioContext.currentTime)
              delayResult.feedback.setValueAtTime(0, audioContext.currentTime)
            }

            this.delayPool.push({
              delayNode: delayResult.node,
              delayParams: { delay: delayResult.delay, feedback: delayResult.feedback },
              delayWetNode,
              delayDryNode,
              isAvailable: true,
              assignedCellIndex: null
            })
          } catch (nodeError) {
            console.warn(`⚠️ Failed to create delay node ${i + 1}:`, nodeError)
            // Continue with other nodes - some might work even if others fail
          }
        }
        console.log(`📱 Delay pool initialized: ${this.delayPool.length} nodes (${8 - this.delayPool.length} failed)`)

        if (this.delayPool.length === 0) {
          console.warn('📱 No delay nodes could be created - delay effects will be disabled')
        } else if (this.delayPool.length < 8) {
          console.warn(`📱 Only ${this.delayPool.length}/8 delay nodes created - limited delay effect availability`)
        }
      } catch (error) {
        console.warn('⚠️ Failed to initialize delay pool:', error)
        console.warn('📱 Delay effects disabled - this is common on mobile browsers')
      }
    } else {
      console.warn('📱 Delay pool disabled - AudioWorklet not supported')
    }

    // Initialize filter pool (8 nodes) - always available
    try {
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
      console.log('📱 Filter pool initialized: 8 nodes')
    } catch (error) {
      console.warn('⚠️ Failed to initialize filter pool:', error)
    }

    // Initialize pitch pool (8 nodes) - only if AudioWorklet is supported
    if (audioContext.audioWorklet) {
      try {
        for (let i = 0; i < 8; i++) {
          try {
            const pitchResult = await Pitch(audioContext)

            // Test if the pitch node is actually working
            if (pitchResult.pitchRatio) {
              pitchResult.pitchRatio.setValueAtTime(1.0, audioContext.currentTime)
            }

            this.pitchPool.push({
              pitchNode: pitchResult.node,
              pitchRatio: pitchResult.pitchRatio,
              isAvailable: true,
              assignedCellIndex: null
            })
          } catch (nodeError) {
            console.warn(`⚠️ Failed to create pitch node ${i + 1}:`, nodeError)
            // Continue with other nodes - some might work even if others fail
          }
        }
        console.log(`📱 Pitch pool initialized: ${this.pitchPool.length} nodes (${8 - this.pitchPool.length} failed)`)

        if (this.pitchPool.length === 0) {
          console.warn('📱 No pitch nodes could be created - pitch effects will be disabled')
        } else if (this.pitchPool.length < 8) {
          console.warn(`📱 Only ${this.pitchPool.length}/8 pitch nodes created - limited pitch effect availability`)
        }
      } catch (error) {
        console.warn('⚠️ Failed to initialize pitch pool:', error)
        console.warn('📱 Pitch effects disabled - this is common on mobile browsers')
      }
    } else {
      console.warn('📱 Pitch pool disabled - AudioWorklet not supported')
    }

    console.log(`📱 Node pools ready: ${this.delayPool.length} delay, ${this.filterPool.length} filter, ${this.pitchPool.length} pitch`)
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

  assignPitchNode(cellIndex: number): PooledPitchNode | null {
    const availableNode = this.pitchPool.find(node => node.isAvailable)
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

  releasePitchNode(cellIndex: number): void {
    const node = this.pitchPool.find(node => node.assignedCellIndex === cellIndex)
    if (node && this.audioContext) {
      // Reset pitch parameters
      if (node.pitchRatio) {
        node.pitchRatio.setValueAtTime(1, this.audioContext.currentTime) // Reset to no pitch shift
      }

      // Disconnect all connections
      node.pitchNode.disconnect()

      node.isAvailable = true
      node.assignedCellIndex = null
    }
  }

  releaseAllNodes(): number[] {
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

    // Release all pitch nodes and track affected cells
    this.pitchPool.forEach((node) => {
      if (!node.isAvailable && node.assignedCellIndex !== null) {
        if (!cellsToRestart.includes(node.assignedCellIndex)) {
          cellsToRestart.push(node.assignedCellIndex)
        }
        this.releasePitchNode(node.assignedCellIndex)
      }
    })

    console.log(`All pool nodes released and ${cellsToRestart.length} stems reconnected`)
    return cellsToRestart
  }

  getAvailableDelayCount(): number {
    return this.delayPool.filter(node => node.isAvailable).length
  }

  getAvailableFilterCount(): number {
    return this.filterPool.filter(node => node.isAvailable).length
  }

  getAvailablePitchCount(): number {
    return this.pitchPool.filter(node => node.isAvailable).length
  }

  getAssignedDelayNode(cellIndex: number): PooledDelayNode | null {
    return this.delayPool.find(node => node.assignedCellIndex === cellIndex) || null
  }

  getAssignedFilterNode(cellIndex: number): PooledFilterNode | null {
    return this.filterPool.find(node => node.assignedCellIndex === cellIndex) || null
  }

  getAssignedPitchNode(cellIndex: number): PooledPitchNode | null {
    return this.pitchPool.find(node => node.assignedCellIndex === cellIndex) || null
  }

  getDelayNodeIndex(cellIndex: number): number {
    const nodeIndex = this.delayPool.findIndex(node => node.assignedCellIndex === cellIndex)
    return nodeIndex >= 0 ? nodeIndex + 1 : -1 // Return 1-based index for display
  }

  getFilterNodeIndex(cellIndex: number): number {
    const nodeIndex = this.filterPool.findIndex(node => node.assignedCellIndex === cellIndex)
    return nodeIndex >= 0 ? nodeIndex + 1 : -1 // Return 1-based index for display
  }

  getPitchNodeIndex(cellIndex: number): number {
    const nodeIndex = this.pitchPool.findIndex(node => node.assignedCellIndex === cellIndex)
    return nodeIndex >= 0 ? nodeIndex + 1 : -1 // Return 1-based index for display
  }
}
