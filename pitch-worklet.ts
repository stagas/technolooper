import { getMemoryView, wasmSourceMap } from 'utils'
import { BUFFER_SIZE } from './as/assembly/constants.ts'
import type { __AdaptedExports as WasmExports } from './as/build/pitch.d.ts'
import hex from './as/build/pitch.wasm?raw-hex'
import { options } from './asconfig-pitch.json'
import { Out } from './shared.ts'

type AudioProcess = (inputs: Float32Array[], outputs: Float32Array[], pitchRatio: number) => void

export interface PlayerProcessorOptions {
  memory: WebAssembly.Memory
  sourcemapUrl: string
}

async function createPlayerController(player: PlayerProcessor) {
  const { sourcemapUrl } = player.options.processorOptions

  const fromHexString = (hexString: string) => Uint8Array.from(
    hexString.match(/.{1,2}/g)!.map(byte =>
      parseInt(byte, 16)
    )
  )
  const uint8 = fromHexString(hex)
  const buffer = wasmSourceMap.setSourceMapURL(uint8.buffer, sourcemapUrl)
  const binary = new Uint8Array(buffer)

  const memory = new WebAssembly.Memory({ initial: options.initialMemory, maximum: options.maximumMemory })
  const mod = await WebAssembly.compile(binary)
  const instance = await WebAssembly.instantiate(mod, {
    env: {
      abort: console.warn,
      log: console.log,
      memory,
    }
  })
  const wasm: typeof WasmExports = instance.exports as any

  const player$ = wasm.createPlayer(sampleRate)

  const view = getMemoryView(memory)

  const createBuffer = () => {
    const buffer$ = wasm.createOut()
    const buffer = Out(memory.buffer, buffer$)
    buffer.L$ = wasm.allocF32(BUFFER_SIZE)
    buffer.R$ = wasm.allocF32(BUFFER_SIZE)
    const buffer_L = view.getF32(buffer.L$, BUFFER_SIZE)
    const buffer_R = view.getF32(buffer.R$, BUFFER_SIZE)
    return [buffer$, buffer_L, buffer_R] as const
  }

  const [output$, output_L, output_R] = createBuffer()
  const [input$, input_L, input_R] = createBuffer()

  let begin: number = 0
  let end: number = BUFFER_SIZE

  let inputs: Float32Array[]
  let outputs: Float32Array[]

  const writeInput = () => {
    input_L.set(inputs[0])
    input_R.set(inputs[1])
  }

  const writeOutput = () => {
    outputs[0]?.set(output_L)
    outputs[1]?.set(output_R)
  }

  const controller: { process: AudioProcess } = {
    process: (_inputs, _outputs, pitchRatio) => {
      inputs = _inputs
      outputs = _outputs
      if (!inputs[0] || !inputs[1]) return true
      writeInput()
      wasm.playerProcess(+player$, begin, end, input$, output$, pitchRatio)
      writeOutput()
    }
  }

  return controller
}

export class PlayerWorklet {
  controller?: Awaited<ReturnType<typeof createPlayerController>>

  process: AudioProcess = () => { }

  async init(player: PlayerProcessor) {
    this.controller = await createPlayerController(player)
    this.process = this.controller.process
  }
}

export class PlayerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitchRatio', defaultValue: 1.0, minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
    ]
  }

  player: PlayerWorklet = new PlayerWorklet()

  constructor(public options: { processorOptions: PlayerProcessorOptions }) {
    super()
    this.player.init(this).then(() => console.log('[pitch-worklet] ready'))
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    const pitchRatio = parameters.pitchRatio[0]
    this.player.process(inputs[0], outputs[0], pitchRatio)
    return true
  }
}

registerProcessor('pitch', PlayerProcessor)
