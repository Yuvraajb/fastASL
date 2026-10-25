import { describe, expect, it, vi } from 'vitest'
import { OBS_CAMERA, selectFaceTimeCamera, selectFaceTimeCameraScript, startObsCamera, START_OBS_CAMERA_SCRIPT, type CallCameraDeps } from './callCamera'

const deps = (answers: (string | Error)[]): CallCameraDeps & { run: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> } => {
  const queue = [...answers]
  return {
    run: vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0]
      if (next instanceof Error) throw next
      return next
    }),
    open: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined)
  }
}

describe('startObsCamera', () => {
  it('clicks Start Virtual Camera, and leaves a camera that is already on alone', async () => {
    expect(await startObsCamera(deps(['started']))).toBe('started')
    expect(await startObsCamera(deps(['already-on']))).toBe('already-on')
    expect(START_OBS_CAMERA_SCRIPT).toContain('"Stop Virtual Camera"')
    expect(START_OBS_CAMERA_SCRIPT).toContain('"Start Virtual Camera"')
  })

  it('launches OBS when it is not running, then tries again', async () => {
    const d = deps(['not-running', 'started'])
    expect(await startObsCamera(d)).toBe('started')
    expect(d.open).toHaveBeenCalledWith('OBS')
    expect(d.run).toHaveBeenCalledTimes(2)
  })

  it('reports what it could not do and never throws', async () => {
    expect(await startObsCamera(deps(['no-button']))).toBe('no-button')
    expect(await startObsCamera(deps(['not-started']))).toBe('not-started')
    expect(await startObsCamera(deps(['not-running']))).toBe('not-running')
    expect(await startObsCamera(deps([new Error('not allowed')]))).toBe('failed')
    expect(await startObsCamera(deps(['???']))).toBe('failed')
  })
})

describe('selectFaceTimeCamera', () => {
  it('names the camera in FaceTime\'s Video menu', () => {
    expect(selectFaceTimeCameraScript(OBS_CAMERA)).toContain('click menu item "OBS Virtual Camera" of menu 1 of menu bar item "Video"')
  })

  it('picks it as soon as FaceTime lists it', async () => {
    const d = deps(['no-camera', 'no-camera', 'selected'])
    expect(await selectFaceTimeCamera(OBS_CAMERA, d, 12_000, 1500)).toBe('selected')
    expect(d.run).toHaveBeenCalledTimes(3)
  })

  it('gives up after the wait, saying why', async () => {
    const d = deps(['no-camera'])
    expect(await selectFaceTimeCamera(OBS_CAMERA, d, 4500, 1500)).toBe('no-camera')
    expect(d.run).toHaveBeenCalledTimes(4) // at 0, 1.5, 3 and 4.5 s
    expect(await selectFaceTimeCamera(OBS_CAMERA, deps(['no-facetime']), 1500, 1500)).toBe('no-facetime')
    expect(await selectFaceTimeCamera(OBS_CAMERA, deps([new Error('x')]), 1500, 1500)).toBe('failed')
  })
})
