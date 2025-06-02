import { Out } from './shared'

export class Player {
  delayBufferL: usize = 0
  delayBufferR: usize = 0
  delayBufferSize: u32 = 0
  writePos: u32 = 0
  maxDelayTime: f32 = 2.0 // 1 second max delay

  constructor(public sampleRate: u32) {
    this.delayBufferSize = u32(f32(this.sampleRate) * this.maxDelayTime)

    // Allocate delay buffers
    this.delayBufferL = heap.alloc(this.delayBufferSize * 4) // 4 bytes per f32
    this.delayBufferR = heap.alloc(this.delayBufferSize * 4)

    // Initialize buffers to zero
    memory.fill(this.delayBufferL, 0, this.delayBufferSize * 4)
    memory.fill(this.delayBufferR, 0, this.delayBufferSize * 4)
  }

  // Cubic interpolation function
  cubicInterpolate(y0: f32, y1: f32, y2: f32, y3: f32, mu: f32): f32 {
    const mu2 = mu * mu
    const a0 = y3 - y2 - y0 + y1
    const a1 = y0 - y1 - a0
    const a2 = y2 - y0
    const a3 = y1

    return a0 * mu * mu2 + a1 * mu2 + a2 * mu + a3
  }

  // Read from delay buffer with cubic interpolation
  readDelayBuffer(buffer: usize, delayInSamples: f32): f32 {
    const delayInt = u32(delayInSamples)
    const delayFrac = delayInSamples - f32(delayInt)

    // Calculate read positions with wrapping
    const pos1 = (this.writePos + this.delayBufferSize - delayInt) % this.delayBufferSize
    const pos0 = (pos1 + this.delayBufferSize - 1) % this.delayBufferSize
    const pos2 = (pos1 + 1) % this.delayBufferSize
    const pos3 = (pos1 + 2) % this.delayBufferSize

    // Read samples
    const y0 = load<f32>(buffer + (pos0 << 2))
    const y1 = load<f32>(buffer + (pos1 << 2))
    const y2 = load<f32>(buffer + (pos2 << 2))
    const y3 = load<f32>(buffer + (pos3 << 2))

    return this.cubicInterpolate(y0, y1, y2, y3, delayFrac)
  }

  process(
    begin: u32,
    end: u32,
    input$: usize,
    output$: usize,
    delay: f32,
    feedback: f32,
  ): void {
    const input = changetype<Out>(input$)
    const output = changetype<Out>(output$)

    const input_L = input.L$
    const input_R = input.R$
    const output_L = output.L$
    const output_R = output.R$

    // Convert delay time from seconds to samples and clamp to valid range
    let delayInSamples = delay * f32(this.sampleRate)
    delayInSamples = f32(Math.max(1.0, Math.min(delayInSamples, f32(this.delayBufferSize - 4))))

    let pos: u32 = begin
    let offset: u32
    let inputSampleL: f32
    let inputSampleR: f32
    let delayedSampleL: f32
    let delayedSampleR: f32
    let outputSampleL: f32
    let outputSampleR: f32

    for (; pos < end; pos++) {
      offset = pos << 2

      // Read input samples
      inputSampleL = load<f32>(input_L + offset)
      inputSampleR = load<f32>(input_R + offset)

      // Read delayed samples with cubic interpolation
      delayedSampleL = this.readDelayBuffer(this.delayBufferL, delayInSamples)
      delayedSampleR = this.readDelayBuffer(this.delayBufferR, delayInSamples)

      // Mix input with delayed signal (dry + wet)
      outputSampleL = inputSampleL + delayedSampleL * 0.5
      outputSampleR = inputSampleR + delayedSampleR * 0.5

      // Write to output
      store<f32>(output_L + offset, outputSampleL)
      store<f32>(output_R + offset, outputSampleR)

      // Write to delay buffer (input + feedback)
      const feedbackSampleL = inputSampleL + delayedSampleL * feedback
      const feedbackSampleR = inputSampleR + delayedSampleR * feedback

      store<f32>(this.delayBufferL + (this.writePos << 2), feedbackSampleL)
      store<f32>(this.delayBufferR + (this.writePos << 2), feedbackSampleR)

      // Advance write position
      this.writePos = (this.writePos + 1) % this.delayBufferSize
    }
  }
}
