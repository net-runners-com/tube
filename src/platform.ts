// Everything that differs between macOS, Windows and Linux, in one place: where Tube keeps its data,
// executable names, the Downloads folder, the Chromium browsers and their profile folders, and how
// to reveal a file, copy text or open a link. Paths are always built with node:path (separators,
// drive letters and spaces differ per OS); nothing here goes through a shell.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { arch, homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const OS = process.platform
export const isWin = OS === 'win32'
export const isMac = OS === 'darwin'
export const ARCH = arch()

const HOME = homedir()
const env = (k: string) => process.env[k] || ''

/** Tube's own folder: cookies, the sign-in profile, downloaded tools. */
export const DATA_DIR = isWin
  ? join(env('APPDATA') || join(HOME, 'AppData', 'Roaming'), 'orca-tube')
  : isMac
    ? join(HOME, 'Library', 'Application Support', 'orca-tube')
    : join(env('XDG_DATA_HOME') || join(HOME, '.local', 'share'), 'orca-tube')

/** `name` as an executable file name on this OS. */
export const exe = (name: string) => (isWin ? `${name}.exe` : name)

/** The user's Downloads folder (XDG's choice on Linux, which may be localized). */
export function downloadsDir(): string {
  if (!isWin && !isMac) {
    try {
      const dir = execFileSync('xdg-user-dir', ['DOWNLOAD'], { encoding: 'utf8', timeout: 2000 }).trim()
      if (dir && dir !== HOME && existsSync(dir)) return dir
    } catch {}
  }
  return join(isWin ? env('USERPROFILE') || HOME : HOME, 'Downloads')
}

/** Folders to look in for a tool that is already installed (besides PATH). */
export function toolDirs(): string[] {
  const path = (process.env.PATH ?? '').split(isWin ? ';' : ':').filter(Boolean)
  const extra = isWin
    ? [join(env('LOCALAPPDATA'), 'Microsoft', 'WinGet', 'Links'), join(HOME, 'scoop', 'shims'), join(env('ProgramData') || 'C:\\ProgramData', 'chocolatey', 'bin')]
    : [join(HOME, '.local', 'bin'), join(HOME, '.nix-profile', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin']
  return [...new Set([...extra, ...path])]
}
export const findTool = (name: string) => toolDirs().map((d) => join(d, exe(name))).find((p) => existsSync(p))

/* ---------------- Chromium browsers ---------------- */

export type Browser = {
  /** yt-dlp's --cookies-from-browser name */
  id: string
  label: string
  /** the folder holding "Local State" and the profiles */
  userData: string
  /** the executable, if installed */
  exe: string | undefined
}

const LOCAL = env('LOCALAPPDATA') || join(HOME, 'AppData', 'Local')
const PF = [env('ProgramFiles') || 'C:\\Program Files', env('ProgramFiles(x86)') || 'C:\\Program Files (x86)', LOCAL]
const CONFIG = env('XDG_CONFIG_HOME') || join(HOME, '.config')
const MAC_SUPPORT = join(HOME, 'Library', 'Application Support')

const first = (paths: string[]) => paths.find((p) => existsSync(p))
const onPath = (...names: string[]) => first(names.flatMap((n) => toolDirs().map((d) => join(d, n))))

/** The Chromium browsers Tube can sign in through, on this OS. */
export function browsers(): Browser[] {
  if (isMac) {
    const app = (name: string) => `/Applications/${name}.app/Contents/MacOS/${name}`
    return [
      { id: 'chrome', label: 'Chrome', userData: join(MAC_SUPPORT, 'Google', 'Chrome'), exe: first([app('Google Chrome'), join(HOME, app('Google Chrome'))]) },
      { id: 'brave', label: 'Brave', userData: join(MAC_SUPPORT, 'BraveSoftware', 'Brave-Browser'), exe: first([app('Brave Browser')]) },
      { id: 'edge', label: 'Edge', userData: join(MAC_SUPPORT, 'Microsoft Edge'), exe: first([app('Microsoft Edge')]) },
      { id: 'vivaldi', label: 'Vivaldi', userData: join(MAC_SUPPORT, 'Vivaldi'), exe: first([app('Vivaldi')]) },
      { id: 'chromium', label: 'Chromium', userData: join(MAC_SUPPORT, 'Chromium'), exe: first([app('Chromium')]) }
    ]
  }
  if (isWin) {
    const inPF = (...rel: string[]) => first(PF.map((root) => join(root, ...rel)))
    return [
      { id: 'chrome', label: 'Chrome', userData: join(LOCAL, 'Google', 'Chrome', 'User Data'), exe: inPF('Google', 'Chrome', 'Application', 'chrome.exe') },
      { id: 'brave', label: 'Brave', userData: join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data'), exe: inPF('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
      { id: 'edge', label: 'Edge', userData: join(LOCAL, 'Microsoft', 'Edge', 'User Data'), exe: inPF('Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { id: 'vivaldi', label: 'Vivaldi', userData: join(LOCAL, 'Vivaldi', 'User Data'), exe: inPF('Vivaldi', 'Application', 'vivaldi.exe') },
      { id: 'chromium', label: 'Chromium', userData: join(LOCAL, 'Chromium', 'User Data'), exe: inPF('Chromium', 'Application', 'chrome.exe') }
    ]
  }
  return [
    { id: 'chrome', label: 'Chrome', userData: join(CONFIG, 'google-chrome'), exe: onPath('google-chrome', 'google-chrome-stable') },
    { id: 'brave', label: 'Brave', userData: join(CONFIG, 'BraveSoftware', 'Brave-Browser'), exe: onPath('brave-browser', 'brave') },
    { id: 'edge', label: 'Edge', userData: join(CONFIG, 'microsoft-edge'), exe: onPath('microsoft-edge', 'microsoft-edge-stable') },
    { id: 'vivaldi', label: 'Vivaldi', userData: join(CONFIG, 'vivaldi'), exe: onPath('vivaldi', 'vivaldi-stable') },
    { id: 'chromium', label: 'Chromium', userData: join(CONFIG, 'chromium'), exe: onPath('chromium', 'chromium-browser') }
  ]
}
/** Any installed Chromium browser, for Tube's own sign-in window. */
export const anyBrowserExe = () => browsers().find((b) => b.exe)?.exe

/* ---------------- desktop actions ---------------- */

const detached = (cmd: string, args: string[]) => {
  const p = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
  p.on('error', () => {})
  p.unref()
}

/** Shows a file in Finder / Explorer / the file manager. */
export function reveal(file: string) {
  if (isMac) detached('open', ['-R', file])
  else if (isWin) detached('explorer.exe', [`/select,${file}`])
  else detached('xdg-open', [dirname(file)])
}

/** Opens a browser profile on youtube.com (to sign in there first). */
export function openBrowserProfile(b: Browser, profile: string | undefined, url: string) {
  if (!b.exe) throw new Error(`${b.label} is not installed`)
  detached(b.exe, [...(profile ? [`--profile-directory=${profile}`] : []), url])
}

/** Puts text on the clipboard with the OS's own tool. */
export function copyText(text: string): Promise<void> {
  const tries: [string, string[]][] = isMac
    ? [['pbcopy', []]]
    : isWin
      ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard']]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]
  return tries.reduce<Promise<void>>(
    (prev, [cmd, args]) =>
      prev.catch(
        () =>
          new Promise<void>((ok, no) => {
            const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
            p.on('error', no)
            p.on('close', (code) => (code === 0 ? ok() : no(new Error(`${cmd} ${code}`))))
            p.stdin.end(text)
          })
      ),
    Promise.reject(new Error('no clipboard tool'))
  )
}
