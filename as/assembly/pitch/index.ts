import { Player } from './player'
import { Out } from '../shared'

export * from '../alloc'

export function createPlayer(sampleRate: u32): Player {
  return new Player(sampleRate)
}

export function playerProcess(
  player$: usize,
  begin: u32,
  end: u32,
  input$: usize,
  output$: usize,
  pitchRatio: f32
): void {
  const player = changetype<Player>(player$)
  player.process(begin, end, input$, output$, pitchRatio)
}

export function createOut(): usize {
  return changetype<usize>(new Out())
}
