import type { PlayerProcessorOptions } from './pitch-worklet.ts'
import pitchWorkletUrl from './pitch-worklet.ts?url'

export class PitchNode extends AudioWorkletNode {
  constructor(
    context: AudioContext,
    sourcemapUrl: string,
  ) {
    super(context, 'pitch', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      processorOptions: <PlayerProcessorOptions>{
        sourcemapUrl,
      }
    })
  }
}

export type Pitch = ReturnType<typeof Pitch>

const registeredContexts = new Set<BaseAudioContext>()
export async function Pitch(ctx: AudioContext) {
  function createNode() {
    const sourcemapUrl = new URL('/as/build/pitch.wasm.map', location.origin).href
    const node = new PitchNode(ctx, sourcemapUrl)
    console.log('created pitch node', node)
    return node
  }

  let node: PitchNode

  if (!registeredContexts.has(ctx)) {
    registeredContexts.add(ctx)
    await ctx.audioWorklet.addModule(pitchWorkletUrl)
    node = createNode()
  }

  else {
    node = createNode()
  }

  const pitchRatio = node.parameters.get('pitchRatio')

  return {
    node,
    pitchRatio,
  }
}
