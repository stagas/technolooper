import { Out } from '../shared'

export class Player {
  windowSize: u32 = 1024
  hopSize: u32 = 256
  overlapSize: u32 = 768

  inputBufferL: usize = 0
  inputBufferR: usize = 0
  outputBufferL: usize = 0
  outputBufferR: usize = 0
  windowBuffer: usize = 0

  inputPos: u32 = 0
  outputPos: u32 = 0
  grainPos: f32 = 0

  constructor(public sampleRate: u32) {
    // Allocate buffers
    this.inputBufferL = heap.alloc(this.windowSize * 4 * 4) // 4x window size for safety
    this.inputBufferR = heap.alloc(this.windowSize * 4 * 4)
    this.outputBufferL = heap.alloc(this.windowSize * 4 * 4)
    this.outputBufferR = heap.alloc(this.windowSize * 4 * 4)
    this.windowBuffer = heap.alloc(this.windowSize * 4)

    // Initialize buffers to zero
    memory.fill(this.inputBufferL, 0, this.windowSize * 4 * 4)
    memory.fill(this.inputBufferR, 0, this.windowSize * 4 * 4)
    memory.fill(this.outputBufferL, 0, this.windowSize * 4 * 4)
    memory.fill(this.outputBufferR, 0, this.windowSize * 4 * 4)

    // Create Hann window
    this.createHannWindow()
  }

  createHannWindow(): void {
    for (let i: u32 = 0; i < this.windowSize; i++) {
      const window = f32(0.5 * (1.0 - f32(Math.cos(2.0 * Math.PI * f64(i) / f64(this.windowSize - 1)))))
      store<f32>(this.windowBuffer + (i << 2), window)
    }
  }

  // Linear interpolation for resampling
  linearInterpolate(buffer: usize, pos: f32): f32 {
    const posInt = u32(pos)
    const posFrac = pos - f32(posInt)

    if (posInt >= this.windowSize - 1) return 0.0

    const sample1 = load<f32>(buffer + (posInt << 2))
    const sample2 = load<f32>(buffer + ((posInt + 1) << 2))

    return sample1 + (sample2 - sample1) * posFrac
  }

  processGrain(inputL: usize, inputR: usize, outputL: usize, outputR: usize, pitchRatio: f32): void {
    // Copy input window to working buffer and apply window function
    for (let i: u32 = 0; i < this.windowSize; i++) {
      const window = load<f32>(this.windowBuffer + (i << 2))
      const sampleL = load<f32>(inputL + (i << 2)) * window
      const sampleR = load<f32>(inputR + (i << 2)) * window

      store<f32>(inputL + (i << 2), sampleL)
      store<f32>(inputR + (i << 2), sampleR)
    }

    // Resample according to pitch ratio
    for (let i: u32 = 0; i < this.windowSize; i++) {
      const sourcePos = f32(i) * pitchRatio

      if (sourcePos < f32(this.windowSize - 1)) {
        const resampledL = this.linearInterpolate(inputL, sourcePos)
        const resampledR = this.linearInterpolate(inputR, sourcePos)
        const window = load<f32>(this.windowBuffer + (i << 2))

        // Apply window and add to output (overlap-add)
        const currentL = load<f32>(outputL + (i << 2))
        const currentR = load<f32>(outputR + (i << 2))

        store<f32>(outputL + (i << 2), currentL + resampledL * window)
        store<f32>(outputR + (i << 2), currentR + resampledR * window)
      }
    }
  }

  process(
    begin: u32,
    end: u32,
    input$: usize,
    output$: usize,
    pitchRatio: f32
  ): void {
    const input = changetype<Out>(input$)
    const output = changetype<Out>(output$)

    const input_L = input.L$
    const input_R = input.R$
    const output_L = output.L$
    const output_R = output.R$

    // Clamp pitch ratio to reasonable range
    const clampedRatio = f32(Math.max(0.25, Math.min(pitchRatio, 4.0)))

    for (let pos: u32 = begin; pos < end; pos++) {
      const offset = pos << 2

      // Fill input buffer
      const inputSampleL = load<f32>(input_L + offset)
      const inputSampleR = load<f32>(input_R + offset)

      const bufferIdx = this.inputPos % this.windowSize
      store<f32>(this.inputBufferL + (bufferIdx << 2), inputSampleL)
      store<f32>(this.inputBufferR + (bufferIdx << 2), inputSampleR)

      this.inputPos++

      // Process grain when we have enough samples
      if (this.inputPos >= this.windowSize && (this.inputPos % this.hopSize) == 0) {
        // Copy current window for processing
        const windowStartL = this.inputBufferL + ((this.inputPos - this.windowSize) % this.windowSize << 2)
        const windowStartR = this.inputBufferR + ((this.inputPos - this.windowSize) % this.windowSize << 2)

        // Process the grain
        this.processGrain(windowStartL, windowStartR, this.outputBufferL, this.outputBufferR, clampedRatio)
      }

      // Output sample
      const outIdx = this.outputPos % this.windowSize
      const outputSampleL = load<f32>(this.outputBufferL + (outIdx << 2))
      const outputSampleR = load<f32>(this.outputBufferR + (outIdx << 2))

      store<f32>(output_L + offset, outputSampleL * 0.3) // Scale down to prevent clipping
      store<f32>(output_R + offset, outputSampleR * 0.3)

      // Clear processed output sample
      store<f32>(this.outputBufferL + (outIdx << 2), 0.0)
      store<f32>(this.outputBufferR + (outIdx << 2), 0.0)

      this.outputPos++
    }
  }
}
