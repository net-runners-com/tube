// Pitch shifter for Tube's audio tools: two read heads sweep a short delay line at `ratio` speed
// and cross-fade (triangle windows that sum to 1), so pitch moves without changing tempo.
// AudioWorklet globals (not in TypeScript's DOM lib)
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, ctor: unknown): void
declare const sampleRate: number

class PitchShifter extends AudioWorkletProcessor {
  win: number
  size: number
  mask: number
  bufs: Float32Array[]
  w: number
  phase: number

  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }]
  }

  constructor() {
    super()
    this.win = Math.round(sampleRate * 0.06) // grain length
    this.size = 1 << Math.ceil(Math.log2(this.win + 8))
    this.mask = this.size - 1
    this.bufs = [new Float32Array(this.size), new Float32Array(this.size)]
    this.w = 0
    this.phase = 0
  }

  read(buf: Float32Array, delay: number) {
    const pos = this.w - delay
    const i = Math.floor(pos)
    const f = pos - i
    return buf[i & this.mask] * (1 - f) + buf[(i + 1) & this.mask] * f
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>) {
    const input = inputs[0]
    const output = outputs[0]
    const ratio = params.ratio[0]
    const frames = output[0].length
    const chans = output.length
    if (!input.length) {
      for (const ch of output) ch.fill(0)
      return true
    }
    const N = this.win
    const step = (1 - ratio) / N
    for (let n = 0; n < frames; n++) {
      for (let c = 0; c < chans; c++) {
        const src = input[Math.min(c, input.length - 1)]
        this.bufs[c][this.w & this.mask] = src[n]
      }
      if (ratio === 1) {
        for (let c = 0; c < chans; c++) output[c][n] = input[Math.min(c, input.length - 1)][n]
      } else {
        const p1 = this.phase
        const p2 = (p1 + 0.5) % 1
        const g1 = 1 - Math.abs(2 * p1 - 1)
        const g2 = 1 - g1
        for (let c = 0; c < chans; c++) {
          const b = this.bufs[c]
          output[c][n] = this.read(b, p1 * N + 1) * g1 + this.read(b, p2 * N + 1) * g2
        }
        this.phase += step
        this.phase -= Math.floor(this.phase)
      }
      this.w = (this.w + 1) & 0x3fffffff
    }
    return true
  }
}
registerProcessor('tube-pitch', PitchShifter)
