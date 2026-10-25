import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import App from './App'
import { CaptionCamera } from './captions/CaptionCamera'

/** ?captions=1: the caption camera window (src/main/captionWindow.ts), not the overlay card. */
const captions = new URLSearchParams(location.search).get('captions') === '1'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>{captions ? <CaptionCamera /> : <App />}</StrictMode>
)
