// variable-delay-processor.js
class VariableDelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'delayTime', defaultValue: 0.0, minValue: 0.0, maxValue: 2.0, automationRate: 'a-rate' }, // Max 2s delay
      { name: 'feedback', defaultValue: 0.3, minValue: 0.0, maxValue: 0.95, automationRate: 'k-rate' }  // Max 0.95 to prevent runaway
    ]
  }

  constructor() {
    super()
    this.maxDelaySamples = sampleRate * 2.0 // Ensure float for calculations
    this.bufferL = new Float32Array(Math.ceil(this.maxDelaySamples)) // Ceil for buffer size
    this.bufferR = new Float32Array(Math.ceil(this.maxDelaySamples))
    // Adjust maxDelaySamples to actual buffer length to prevent off-by-one with Math.min later
    this.maxDelaySamples = this.bufferL.length

    this.writeIndex = 0
    this.lastFeedback = 0.3
  }

  _cubicInterpolate(p0, p1, p2, p3, t) {
    const t2 = t * t
    const t3 = t2 * t
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    )
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]    // [[L_channel_data], [R_channel_data]]
    const output = outputs[0]  // [[L_channel_data], [R_channel_data]]
    const blockSize = input[0] ? input[0].length : 128 // Standard block size (e.g., 128 samples)

    const delayTimeValues = parameters.delayTime // Can be a-rate (128 values) or k-rate (1 value)
    const feedbackValues = parameters.feedback   // k-rate (1 value for the block)

    // For k-rate parameters, use the first value.
    this.lastFeedback = feedbackValues[0]

    for (let i = 0; i < blockSize; i++) {
      // Determine current delay time for this specific sample if a-rate, or use the first value if k-rate (though defined as a-rate)
      const currentDelayTimeSec = delayTimeValues.length > 1 ? delayTimeValues[i] : delayTimeValues[0]

      // Calculate exact delay in samples (float)
      let actualDelayInSamples = currentDelayTimeSec * sampleRate
      // Clamp delay to valid range: [0, max buffer delay allowed which is maxDelaySamples - safety_margin_for_interpolation]
      // For cubic interpolation, we need up to P3 (delay baseDelayInt+2).
      // So, max actualDelayInSamples should be such that baseDelayInt+2 is still a valid delay.
      // Max baseDelayInt = maxDelaySamples - 1 - 2 = maxDelaySamples - 3 if buffer is 0-indexed maxDelaySamples-1.
      // Thus, actualDelayInSamples should be < maxDelaySamples - 2.
      // Let's use maxDelaySamples - 3 as a safe upper bound for actualDelayInSamples to ensure P3 is valid.
      // Smallest delay is 0.
      actualDelayInSamples = Math.max(0.0, Math.min(actualDelayInSamples, this.maxDelaySamples - 3.0))

      const baseDelayInt = Math.floor(actualDelayInSamples)
      const fraction = actualDelayInSamples - baseDelayInt

      // Indices for Catmull-Rom interpolation points (P0, P1, P2, P3)
      // P1 corresponds to sample delayed by baseDelayInt
      const idxP1 = (this.writeIndex - baseDelayInt + this.maxDelaySamples) % this.maxDelaySamples
      const idxP0 = (this.writeIndex - (baseDelayInt - 1) + this.maxDelaySamples) % this.maxDelaySamples
      const idxP2 = (this.writeIndex - (baseDelayInt + 1) + this.maxDelaySamples) % this.maxDelaySamples
      const idxP3 = (this.writeIndex - (baseDelayInt + 2) + this.maxDelaySamples) % this.maxDelaySamples

      const inputL = input[0] ? input[0][i] : 0 // Get left channel sample, or 0 if not present
      const inputR = input[1] ? input[1][i] : inputL // Get right channel sample, or use left channel for mono

      // Get samples for Left channel interpolation
      const p0L = this.bufferL[idxP0]
      const p1L = this.bufferL[idxP1]
      const p2L = this.bufferL[idxP2]
      const p3L = this.bufferL[idxP3]
      const delayedL = this._cubicInterpolate(p0L, p1L, p2L, p3L, fraction)

      // Get samples for Right channel interpolation
      const p0R = this.bufferR[idxP0]
      const p1R = this.bufferR[idxP1]
      const p2R = this.bufferR[idxP2]
      const p3R = this.bufferR[idxP3]
      const delayedR = this._cubicInterpolate(p0R, p1R, p2R, p3R, fraction)

      // Output the WET signal (interpolated delayed signal)
      if (output[0]) {
        output[0][i] = delayedL
      }
      if (output[1]) {
        output[1][i] = delayedR
      } else if (output[0]) {
        // If output is mono (e.g. 1 channel), and we have stereo delay, mix or pick one.
        // For simplicity, outputting L channel if output is mono but delay was stereo.
        output[0][i] = delayedL
      }

      // Write to delay buffer: current input + feedback * (non-interpolated P1 sample)
      this.bufferL[this.writeIndex] = inputL + this.lastFeedback * p1L
      this.bufferR[this.writeIndex] = inputR + this.lastFeedback * p1R

      // Increment writeIndex and wrap around if it reaches the end of the buffer
      this.writeIndex = (this.writeIndex + 1) % this.maxDelaySamples
    }

    return true // Keep the processor alive
  }
}

registerProcessor('variable-delay-processor', VariableDelayProcessor)
