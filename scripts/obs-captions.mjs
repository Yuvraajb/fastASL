// Points OBS at fastASL's caption camera window and turns on OBS Virtual Camera, so FaceTime (or any
// call app) can use the captioned video as its camera. Talks to OBS over obs-websocket
// (OBS 28+: Tools › WebSocket Server Settings, enable it and set a password).
//
//   npm run obs              first time: 1280x720 30 fps canvas, a "fastASL Captions" window capture
//                            filling it (the title bar cropped off), and the virtual camera on
//   npm run obs -- --repoint after restarting fastASL: the window is new, so point the source at it
//
// Needs fastASL running with its caption window open (npm run dev:captions), and
// OBS_WS_PASSWORD (and OBS_WS_URL if not ws://127.0.0.1:4455) in .env.
import { createHash } from 'node:crypto'
import dotenv from 'dotenv'

dotenv.config({ quiet: true })

const URL = process.env.OBS_WS_URL?.trim() || 'ws://127.0.0.1:4455'
const PASSWORD = process.env.OBS_WS_PASSWORD?.trim() ?? ''
const WINDOW_TITLE = 'fastASL Captions'
const INPUT = 'fastASL Captions'
const CANVAS = { width: 1280, height: 720 }
const repointOnly = process.argv.includes('--repoint')

if (typeof WebSocket === 'undefined') {
  console.error('This needs Node 22+, or Node 20 with --experimental-websocket (npm run obs passes it).')
  process.exit(1)
}

const sha = (text) => createHash('sha256').update(text).digest('base64')
const ws = new WebSocket(URL, 'obswebsocket.json')
const pending = new Map()
let seq = 0

function request(requestType, requestData = {}) {
  const requestId = `r${++seq}`
  ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }))
  return new Promise((resolve, reject) => pending.set(requestId, { resolve, reject, requestType }))
}

const identified = new Promise((resolve, reject) => {
  ws.onerror = () => reject(new Error(`can't reach OBS at ${URL}: is OBS open with its WebSocket server on?`))
  ws.onclose = (e) => reject(new Error(`OBS closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ''}): check OBS_WS_PASSWORD`))
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.op === 0) {
      const auth = msg.d.authentication
      if (auth && !PASSWORD) return reject(new Error('OBS asks for a password: set OBS_WS_PASSWORD in .env'))
      const authentication = auth ? sha(sha(PASSWORD + auth.salt) + auth.challenge) : undefined
      ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, ...(authentication && { authentication }) } }))
    } else if (msg.op === 2) resolve()
    else if (msg.op === 7) {
      const p = pending.get(msg.d.requestId)
      if (!p) return
      pending.delete(msg.d.requestId)
      const { result, code, comment } = msg.d.requestStatus
      if (result) p.resolve(msg.d.responseData ?? {})
      else p.reject(new Error(`${p.requestType} failed (${code}): ${comment ?? ''}`))
    }
  }
})

/** The capture's window list entry for fastASL's caption window (the newest, if there are several). */
async function captionWindow(settings) {
  const { propertyItems } = await request('GetInputPropertiesListPropertyItems', { inputName: INPUT, propertyName: 'window' })
  const matches = propertyItems.filter((i) => String(i.itemName).includes(WINDOW_TITLE))
  if (!matches.length) {
    const seen = propertyItems.map((i) => `  ${i.itemName}`).join('\n') || '  (none: give OBS Screen Recording access)'
    throw new Error(`no "${WINDOW_TITLE}" window. Is fastASL running with its caption window (npm run dev:captions)?\nOBS sees:\n${seen}`)
  }
  const match = matches[matches.length - 1]
  await request('SetInputSettings', { inputName: INPUT, inputSettings: { ...settings, window: match.itemValue } })
  return match.itemName
}

/** Crops the window's title bar and fits the rest to the canvas. */
async function fitToCanvas(scene, sceneItemId) {
  const { sceneItemTransform: t } = await request('GetSceneItemTransform', { sceneName: scene, sceneItemId })
  const titleBar = Math.max(0, Math.round(t.sourceHeight - (t.sourceWidth * CANVAS.height) / CANVAS.width))
  await request('SetSceneItemTransform', {
    sceneName: scene,
    sceneItemId,
    sceneItemTransform: {
      cropTop: titleBar,
      positionX: 0,
      positionY: 0,
      alignment: 5,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsAlignment: 0,
      boundsWidth: CANVAS.width,
      boundsHeight: CANVAS.height
    }
  })
}

async function main() {
  await identified
  const { obsVersion } = await request('GetVersion')
  const kinds = (await request('GetInputKindList')).inputKinds
  const kind = ['screen_capture', 'window_capture'].find((k) => kinds.includes(k))
  if (!kind) throw new Error(`no window capture source in OBS ${obsVersion}`)
  const settings = kind === 'screen_capture' ? { type: 1, show_cursor: false } : { show_cursor: false }
  const scene = (await request('GetSceneList')).currentProgramSceneName
  const inputs = (await request('GetInputList')).inputs
  const exists = inputs.some((i) => i.inputName === INPUT)

  if (repointOnly && exists) {
    const { sceneItemId } = await request('GetSceneItemId', { sceneName: scene, sourceName: INPUT })
    console.log(`capturing: ${await captionWindow(settings)}`)
    await fitToCanvas(scene, sceneItemId)
  } else {
    const vcam = await request('GetVirtualCamStatus')
    if (vcam.outputActive) await request('StopVirtualCam')
    await request('SetVideoSettings', {
      baseWidth: CANVAS.width,
      baseHeight: CANVAS.height,
      outputWidth: CANVAS.width,
      outputHeight: CANVAS.height,
      fpsNumerator: 30,
      fpsDenominator: 1
    })
    if (exists) await request('RemoveInput', { inputName: INPUT })
    const { sceneItemId } = await request('CreateInput', { sceneName: scene, inputName: INPUT, inputKind: kind, inputSettings: settings, sceneItemEnabled: true })
    console.log(`OBS ${obsVersion}: "${INPUT}" in scene "${scene}", canvas ${CANVAS.width}x${CANVAS.height} @ 30 fps`)
    console.log(`capturing: ${await captionWindow(settings)}`)
    // Give the capture a moment to report the window's size before cropping its title bar.
    await new Promise((r) => setTimeout(r, 500))
    await fitToCanvas(scene, sceneItemId)
  }

  const status = await request('GetVirtualCamStatus')
  if (!status.outputActive) await request('StartVirtualCam')
  const after = await request('GetVirtualCamStatus')
  console.log(
    after.outputActive
      ? 'OBS Virtual Camera is on: pick it as the camera in FaceTime (Video menu).'
      : 'Virtual Camera did not start: allow the OBS camera extension in System Settings › General › Login Items & Extensions, then run this again.'
  )
}

main()
  .then(() => ws.close())
  .catch((err) => {
    console.error(`obs: ${err.message}`)
    ws.close()
    process.exitCode = 1
  })
