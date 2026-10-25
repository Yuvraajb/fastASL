// A stand-in screenshot for the mock services and `npm run screens`: a desktop with a window
// and the fastASL card, as a small SVG data URL (the real one is a PNG from main).

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
<defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38455f"/><stop offset="1" stop-color="#6b5a7e"/></linearGradient></defs>
<rect width="320" height="200" fill="url(#w)"/>
<rect width="320" height="9" fill="#ffffff" fill-opacity="0.35"/>
<rect x="26" y="28" width="196" height="138" rx="6" fill="#f4f4f6"/>
<rect x="26" y="28" width="196" height="15" rx="6" fill="#e1e1e6"/>
<circle cx="35" cy="35.5" r="2.6" fill="#ff5f57"/><circle cx="43" cy="35.5" r="2.6" fill="#febc2e"/><circle cx="51" cy="35.5" r="2.6" fill="#28c840"/>
<rect x="40" y="56" width="118" height="7" rx="3.5" fill="#c6c6ce"/>
<rect x="40" y="72" width="164" height="6" rx="3" fill="#dcdce2"/>
<rect x="40" y="85" width="146" height="6" rx="3" fill="#dcdce2"/>
<rect x="40" y="98" width="156" height="6" rx="3" fill="#dcdce2"/>
<rect x="40" y="118" width="70" height="34" rx="4" fill="#d3d6de"/>
<rect x="242" y="16" width="64" height="74" rx="10" fill="#111316" fill-opacity="0.92"/>
<rect x="249" y="30" width="50" height="34" rx="5" fill="#2b2c2e"/>
<rect x="249" y="70" width="34" height="5" rx="2.5" fill="#ffffff" fill-opacity="0.7"/>
</svg>`

export const MOCK_SCREENSHOT_THUMB = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`
export const MOCK_SCREENSHOT_PATH = '/Users/you/Desktop/fastASL Screenshot 2026-10-25 at 10.00.00.png'
export const MOCK_SCREENSHOT_SUBTITLE = 'Desktop · fastASL Screenshot 2026-10-25 at 10.00.00.png'
