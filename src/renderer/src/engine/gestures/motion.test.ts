import { describe, expect, it } from 'vitest'
import { HandTracks, type MotionSample, type Track } from './motion'

const at = (t: number, x: number): MotionSample => ({ t, x, y: 0.5, palm: 0.1, flat: true })

describe('HandTracks', () => {
  it('pairs hands with tracks by nearest wrist globally, whatever order they arrive in', () => {
    const tracks = new HandTracks()
    const [first] = tracks.update([at(0, 0.6)], 0)
    // The new hand (0.35) is listed first and is within matching range of the existing track.
    const [newcomer, same] = tracks.update([at(33, 0.35), at(33, 0.6)], 33)
    expect(same).toBe(first)
    expect(same.samples.map((s) => s.x)).toEqual([0.6, 0.6])
    expect(newcomer).not.toBe(first)
    expect(newcomer.samples).toHaveLength(1)
  })

  it('settles a track only once its wrist has been at rest', () => {
    const tracks = new HandTracks()
    let track: Track | undefined
    for (let t = 0; t <= 300; t += 33) [track] = tracks.update([at(t, 0.9 - t / 1000)], t)
    expect(track?.settledAt).toBeNull()
    for (let t = 333; t <= 600; t += 33) [track] = tracks.update([at(t, 0.6)], t)
    expect(track?.settledAt).toBeGreaterThan(333)
  })

  it('starts a new, unsettled track for a hand that returns after a gap', () => {
    const tracks = new HandTracks()
    let track: Track | undefined
    for (let t = 0; t <= 300; t += 33) [track] = tracks.update([at(t, 0.5)], t)
    expect(track?.settledAt).not.toBeNull()
    const [back] = tracks.update([at(700, 0.5)], 700)
    expect(back).not.toBe(track)
    expect(back.settledAt).toBeNull()
  })
})
