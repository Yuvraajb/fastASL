import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'

/** ?captions=1: the caption camera window (src/main/captionWindow.ts), not the overlay card. */
const captions = new URLSearchParams(location.search).get('captions') === '1'
const root = createRoot(document.getElementById('root') as HTMLElement)

// Each window loads only its own code. Importing App creates the overlay's controller, which
// listens to agent events and declines a Confirm for a run it doesn't know: in the caption
// window a second controller declined every Confirm the moment it was asked.
if (captions) {
  void import('./captions/CaptionCamera').then(({ CaptionCamera }) =>
    root.render(
      <StrictMode>
        <CaptionCamera />
      </StrictMode>
    )
  )
} else {
  void import('./App').then(({ default: App }) =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  )
}
