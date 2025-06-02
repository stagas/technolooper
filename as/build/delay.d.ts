declare namespace __AdaptedExports {
  /** Exported memory */
  export const memory: WebAssembly.Memory;
  /**
   * as/assembly/delay/index/createPlayer
   * @param sampleRate `u32`
   * @returns `as/assembly/delay/player/Player`
   */
  export function createPlayer(sampleRate: number): __Internref4;
  /**
   * as/assembly/delay/index/playerProcess
   * @param player$ `usize`
   * @param begin `u32`
   * @param end `u32`
   * @param input$ `usize`
   * @param output$ `usize`
   * @param delay `f32`
   * @param feedback `f32`
   */
  export function playerProcess(player$: number, begin: number, end: number, input$: number, output$: number, delay: number, feedback: number): void;
  /**
   * as/assembly/delay/index/createOut
   * @returns `usize`
   */
  export function createOut(): number;
  /**
   * as/assembly/alloc/heap_alloc
   * @param size `usize`
   * @returns `usize`
   */
  export function heap_alloc(size: number): number;
  /**
   * as/assembly/alloc/heap_free
   * @param ptr `usize`
   */
  export function heap_free(ptr: number): void;
  /**
   * as/assembly/alloc/allocI32
   * @param length `i32`
   * @returns `usize`
   */
  export function allocI32(length: number): number;
  /**
   * as/assembly/alloc/allocU32
   * @param length `i32`
   * @returns `usize`
   */
  export function allocU32(length: number): number;
  /**
   * as/assembly/alloc/allocF32
   * @param length `i32`
   * @returns `usize`
   */
  export function allocF32(length: number): number;
}
/** as/assembly/delay/player/Player */
declare class __Internref4 extends Number {
  private __nominal4: symbol;
  private __nominal0: symbol;
}
/** Instantiates the compiled WebAssembly module with the given imports. */
export declare function instantiate(module: WebAssembly.Module, imports: {
  env: unknown,
}): Promise<typeof __AdaptedExports>;
