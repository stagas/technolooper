import { Delay } from './delay-node.ts'
import type { PooledDelayNode, PooledFilterNode } from './types.ts'

// Audio Node Pools System
export class NodePool {
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

    console.log(`All pool nodes released and ${cellsToRestart.length} stems reconnected`)
    return cellsToRestart
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
