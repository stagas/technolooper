import type { PlayerProcessorOptions } from './delay-worklet.ts'
import delayWorkletUrl from './delay-worklet.ts?url'

export class DelayNode extends AudioWorkletNode {
  constructor(
    context: AudioContext,
    sourcemapUrl: string,
  ) {
    super(context, 'delay', {
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

export type Delay = ReturnType<typeof Delay>

const registeredContexts = new Set<BaseAudioContext>()
export async function Delay(ctx: AudioContext) {
  function createNode() {
    const sourcemapUrl = new URL('/as/build/delay.wasm.map', location.origin).href
    const node = new DelayNode(ctx, sourcemapUrl)
    console.log('created delay node', node)
    return node
  }

  let node: DelayNode

  if (!registeredContexts.has(ctx)) {
    registeredContexts.add(ctx)
    await ctx.audioWorklet.addModule(delayWorkletUrl)
    node = createNode()
  }
  else {
    node = createNode()
  }

  const delay = node.parameters.get('delay')
  const feedback = node.parameters.get('feedback')

  return {
    node,
    delay,
    feedback,
  }
}
