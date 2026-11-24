// Updating Tube itself: the worker runs Orca's own CLI (`orca plugin update`) with the Orca it runs
// in. An update that asks for no new access keeps its approval, so it goes through without a prompt;
// one that would need new access is left to the person (Orca's Settings ▸ Plugins), never approved here.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findTool } from './platform'

/** Tube's plugin key in Orca (publisher.id). */
export const PLUGIN_KEY = 'net-runners-com.tube'

/** Orca's CLI script, next to the Orca the worker runs on (macOS, Windows and Linux layouts). */
function orcaCli(): { file: string; args: string[]; env: Record<string, string> } | null {
  const resources = [
    (process as any).resourcesPath as string | undefined,
    join(dirname(process.execPath), '..', 'Resources'),
    join(dirname(process.execPath), 'resources')
  ].filter(Boolean) as string[]
  for (const r of resources) {
    const cli = join(r, 'app.asar.unpacked', 'out', 'cli', 'index.js')
    if (existsSync(cli)) return { file: process.execPath, args: [cli], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  const onPath = findTool('orca')
  return onPath ? { file: onPath, args: [], env: {} } : null
}

export type UpdateResult = { ok: true; version: string } | { ok: false; needsApproval?: boolean; error: string }

export function updateTube(): Promise<UpdateResult> {
  const cli = orcaCli()
  if (!cli) return Promise.resolve({ ok: false, error: "Orca's command line was not found" })
  return new Promise((resolve) =>
    execFile(
      cli.file,
      [...cli.args, 'plugin', 'update', PLUGIN_KEY, '--json'],
      { timeout: 180_000, windowsHide: true, env: { ...process.env, ...cli.env } },
      (_e, out) => {
        let r: any = null
        try {
          r = JSON.parse(String(out).slice(String(out).indexOf('{')))
        } catch {}
        if (!r) return resolve({ ok: false, error: 'Orca did not answer' })
        if (r.ok) return resolve({ ok: true, version: r.result?.version ?? r.result?.plugin?.version ?? '' })
        const code = r.error?.code
        resolve({
          ok: false,
          needsApproval: code === 'approval_required' || code === 'approval_stale',
          error: String(r.error?.message ?? 'Update failed').split('\n')[0]
        })
      }
    )
  )
}
