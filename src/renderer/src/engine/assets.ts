/**
 * Whether a file bundled next to the page (public/) is there. The dev server answers a missing
 * file with index.html, so HTML counts as missing; file:// rejects.
 */
export async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url)
    void res.body?.cancel()
    return res.ok && !res.headers.get('content-type')?.includes('text/html')
  } catch {
    return false
  }
}
