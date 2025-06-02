import { Out } from '../shared'

export class Player {
  grainSize: u32 = 2048
  hopSize: u32 = 512
  overlapFactor: u32 = 4
  bufferSize: u32 = 8192

  inputBufferL: usize = 0
  inputBufferR: usize = 0
  outputBufferL: usize = 0
  outputBufferR: usize = 0
  windowBuffer: usize = 0

  writePos: u32 = 0
  grain1PosL: f32 = 0
  grain1PosR: f32 = 0
  grain2PosL: f32 = 0
  grain2PosR: f32 = 0
  grainPhase: u32 = 0

  constructor(public sampleRate: u32) {
    // Allocate larger circular buffers for better quality
    this.inputBufferL = heap.alloc(this.bufferSize * 4)
    this.inputBufferR = heap.alloc(this.bufferSize * 4)
    this.outputBufferL = heap.alloc(this.bufferSize * 4)
    this.outputBufferR = heap.alloc(this.bufferSize * 4)
    this.windowBuffer = heap.alloc(this.grainSize * 4)

    // Initialize buffers to zero
    memory.fill(this.inputBufferL, 0, this.bufferSize * 4)
    memory.fill(this.inputBufferR, 0, this.bufferSize * 4)
    memory.fill(this.outputBufferL, 0, this.bufferSize * 4)
    memory.fill(this.outputBufferR, 0, this.bufferSize * 4)

    // Create Hann window for better quality
    this.createHannWindow()

    // Initialize grain positions with offset for smoother crossfading
    this.grain2PosL = f32(this.grainSize / 2)
    this.grain2PosR = f32(this.grainSize / 2)
  }

  // Create high-quality Hann window
  createHannWindow(): void {
    for (let i: u32 = 0; i < this.grainSize; i++) {
      const phase = f32(i) / f32(this.grainSize - 1)
      const window = 0.5 * (1.0 - f32(Math.cos(2.0 * Math.PI * f64(phase))))
      store<f32>(this.windowBuffer + (i << 2), window)
    }
  }

  // High-quality cubic interpolation
  cubicInterpolate(buffer: usize, pos: f32): f32 {
    const idx = u32(pos) % this.bufferSize
    const frac = pos - f32(u32(pos))

    // Get 4 points for cubic interpolation
    const idx0 = (idx - 1 + this.bufferSize) % this.bufferSize
    const idx1 = idx
    const idx2 = (idx + 1) % this.bufferSize
    const idx3 = (idx + 2) % this.bufferSize

    const y0 = load<f32>(buffer + (idx0 << 2))
    const y1 = load<f32>(buffer + (idx1 << 2))
    const y2 = load<f32>(buffer + (idx2 << 2))
    const y3 = load<f32>(buffer + (idx3 << 2))

    // Cubic interpolation coefficients
    const c0 = y1
    const c1 = 0.5 * (y2 - y0)
    const c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)

    return c0 + c1 * frac + c2 * frac * frac + c3 * frac * frac * frac
  }

  // Generate a single grain with windowing
  processGrain(
    inputBuffer: usize,
    outputBuffer: usize,
    grainPos: f32,
    pitchRatio: f32,
    outputGain: f32
  ): f32 {
    let readPos = grainPos

    // Process grain with Hann windowing
    for (let i: u32 = 0; i < this.grainSize; i++) {
      if (readPos >= 0 && readPos < f32(this.bufferSize - 1)) {
        const sample = this.cubicInterpolate(inputBuffer, readPos)
        const window = load<f32>(this.windowBuffer + (i << 2))

        // Add to output buffer with proper overlap-add
        const outputIdx = (this.writePos + i) % this.bufferSize
        const currentOut = load<f32>(outputBuffer + (outputIdx << 2))
        store<f32>(outputBuffer + (outputIdx << 2),
          currentOut + sample * window * outputGain)
      }

      readPos += pitchRatio

      // Wrap around buffer if needed
      if (readPos >= f32(this.bufferSize)) {
        readPos -= f32(this.bufferSize)
      }
    }

    return readPos
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

    // True bypass mode when ratio is very close to 1.0
    if (f32(Math.abs(clampedRatio - 1.0)) < 0.001) {
      for (let pos: u32 = begin; pos < end; pos++) {
        const offset = pos << 2
        const inputSampleL = load<f32>(input_L + offset)
        const inputSampleR = load<f32>(input_R + offset)

        store<f32>(output_L + offset, inputSampleL)
        store<f32>(output_R + offset, inputSampleR)
      }
      return
    }

    // High-quality granular pitch shifting
    for (let pos: u32 = begin; pos < end; pos++) {
      const offset = pos << 2

      // Write input to circular buffer
      const inputSampleL = load<f32>(input_L + offset)
      const inputSampleR = load<f32>(input_R + offset)

      const writeIdx = this.writePos % this.bufferSize
      store<f32>(this.inputBufferL + (writeIdx << 2), inputSampleL)
      store<f32>(this.inputBufferR + (writeIdx << 2), inputSampleR)

      // Process grains when we have enough input
      if (this.writePos > this.grainSize * 2) {
        // Process overlapping grains for smooth output
        if ((this.grainPhase % this.hopSize) == 0) {
          // Calculate adaptive grain gain based on pitch ratio
          const grainGain = f32(Math.min(1.0, 0.7 / Math.sqrt(f64(clampedRatio))))

          // Process two overlapping grains for smoother results
          this.grain1PosL = this.processGrain(
            this.inputBufferL,
            this.outputBufferL,
            this.grain1PosL,
            clampedRatio,
            grainGain * 0.5
          )

          this.grain1PosR = this.processGrain(
            this.inputBufferR,
            this.outputBufferR,
            this.grain1PosR,
            clampedRatio,
            grainGain * 0.5
          )

          // Second grain offset by half grain size for better overlap
          this.grain2PosL = this.processGrain(
            this.inputBufferL,
            this.outputBufferL,
            this.grain2PosL,
            clampedRatio,
            grainGain * 0.5
          )

          this.grain2PosR = this.processGrain(
            this.inputBufferR,
            this.outputBufferR,
            this.grain2PosR,
            clampedRatio,
            grainGain * 0.5
          )
        }
      }

      // Output processed sample
      const outputIdx = this.writePos % this.bufferSize
      let outputSampleL = load<f32>(this.outputBufferL + (outputIdx << 2))
      let outputSampleR = load<f32>(this.outputBufferR + (outputIdx << 2))

      // Clear output buffer for next cycle
      store<f32>(this.outputBufferL + (outputIdx << 2), 0.0)
      store<f32>(this.outputBufferR + (outputIdx << 2), 0.0)

      // Apply final gain and anti-aliasing
      const finalGain = f32(0.9)
      outputSampleL = f32(Math.max(-1.0, Math.min(1.0, f64(outputSampleL * finalGain))))
      outputSampleR = f32(Math.max(-1.0, Math.min(1.0, f64(outputSampleR * finalGain))))

      store<f32>(output_L + offset, outputSampleL)
      store<f32>(output_R + offset, outputSampleR)

      this.writePos++
      this.grainPhase++
    }
  }
}
