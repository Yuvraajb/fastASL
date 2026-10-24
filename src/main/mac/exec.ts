import { execFile } from 'node:child_process'

/** Runs a command without a shell; rejects with its stderr text. */
export function exec(cmd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout.trim())
    })
  })
}

/** Reads a user default (`defaults read <domain> <key>`), or null when unset. */
export async function readDefault(domain: string, key: string): Promise<string | null> {
  try {
    return (await exec('defaults', ['read', domain, key], 3000)) || null
  } catch {
    return null
  }
}
