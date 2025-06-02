import { Struct } from 'utils'

export const enum PlayerMode {
  Idle,
  Reset,
  Stop,
  Play,
  Pause,
}

export const Out = Struct({
  L$: 'usize',
  R$: 'usize',
})
