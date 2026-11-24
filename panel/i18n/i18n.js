// Tube's i18n. The English text in the code is the key; a language file maps it to a translation.
// Keys may hold {placeholders} ("Quality: up to {n}p"); the matching parts carry over.
//
// Two ways in:
//  - t(key, vars) for strings built in code;
//  - everything drawn into the page (text, placeholder, aria-label, title) is translated as it
//    appears, when the whole text matches a key. Mark user content with data-no-i18n to skip it.
//
// Adding a language: copy ja.js to <code>.js, translate the values, add it to LANGS.

export const LANGS = [
  ['auto', 'System'],
  ['en', 'English'],
  ['ja', '日本語']
]

let code = 'en'
let exact = new Map()
let raw = new Map() // every key, {placeholder} ones too (for t())
let patterns = [] // [regex, names, value]

const escapeRe = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&')
function compile(dict) {
  exact = new Map()
  raw = new Map(Object.entries(dict))
  patterns = []
  for (const [k, v] of Object.entries(dict)) {
    if (!/\{\w+\}/.test(k)) {
      exact.set(k, v)
      continue
    }
    const names = []
    const re = k
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part)
        if (!m) return escapeRe(part)
        names.push(m[1])
        return '(.+?)'
      })
      .join('')
    patterns.push([new RegExp(`^${re}$`), names, v])
  }
}

/** Orca's UI language, as one of ours ('en' when we don't have it). */
export function orcaLang() {
  const tag = (globalThis.orca?.locale || navigator.language || 'en').slice(0, 2).toLowerCase()
  return LANGS.some(([k]) => k === tag && k !== 'auto') ? tag : 'en'
}
/** The language actually used for a setting ('auto' follows Orca's language). */
export function resolve(pref) {
  if (pref && pref !== 'auto') return pref
  return orcaLang()
}
export const current = () => code

export async function setLang(pref) {
  code = resolve(pref)
  let dict = {}
  if (code !== 'en') {
    try {
      dict = (await import(`./${code}.js`)).default
    } catch {
      code = 'en'
    }
  }
  compile(dict)
  document.documentElement.lang = code
  retranslateAll()
}

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m))

/** Translate a key, filling {placeholders} from vars. */
export function t(key, vars) {
  return fill(raw.get(key) ?? key, vars)
}

/** Translate a whole piece of text drawn on the page (exact key or a {placeholder} pattern). */
export function translate(text) {
  // most updates are numbers and times ("1:23", "42%"): nothing to look up
  if (code === 'en' || !text || !/[A-Za-z]/.test(text)) return text
  const k = text.trim()
  if (!k) return text
  let out = exact.get(k)
  if (out == null) {
    for (const [re, names, v] of patterns) {
      const m = re.exec(k)
      if (m) {
        out = fill(v, Object.fromEntries(names.map((n, i) => [n, translate(m[i + 1])])))
        break
      }
    }
  }
  if (out == null) return text
  return text.replace(k, out)
}

/* ---- the page ---- */
const seen = new WeakMap() // text node → { src, out }
const ATTRS = ['placeholder', 'aria-label', 'title']
// titles (clamped), comments, chat, lyrics: what people wrote is never translated
const skip = (el) => !el || el.closest?.('script, style, textarea, option, [data-no-i18n], .clamp2, .clamp3, .clamp4, #cmList')

function doText(node) {
  if (skip(node.parentElement)) return
  const rec = seen.get(node)
  const src = rec && node.nodeValue === rec.out ? rec.src : node.nodeValue
  const out = translate(src)
  seen.set(node, { src, out })
  if (out !== node.nodeValue) node.nodeValue = out
}
function doAttrs(el) {
  if (skip(el)) return
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue
    const key = `i18n${a.replace(/-./g, (m) => m[1].toUpperCase())}`
    const cur = el.getAttribute(a)
    const src = el.dataset[key] != null && cur === el.dataset[`${key}Out`] ? el.dataset[key] : cur
    const out = translate(src)
    el.dataset[key] = src
    el.dataset[`${key}Out`] = out
    if (out !== cur) el.setAttribute(a, out)
  }
}
function walk(root) {
  if (root.nodeType === 3) return doText(root)
  if (root.nodeType !== 1) return
  doAttrs(root)
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = tw.nextNode(); n; n = tw.nextNode()) n.nodeType === 3 ? doText(n) : doAttrs(n)
}
export function retranslateAll() {
  walk(document.body)
}

let observer = null
/** Translate what is on the page now and everything drawn later. */
export function startI18n() {
  if (observer) return
  observer = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'characterData') doText(r.target)
      else if (r.type === 'attributes') doAttrs(r.target)
      else for (const n of r.addedNodes) walk(n)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS })
  retranslateAll()
}
