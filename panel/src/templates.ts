// Starting points for Settings ▸ Custom CSS and Custom script, offered as downloads.

export const CSS_TEMPLATE = `/*
 * Tube — custom CSS template
 * Paste what you need into Settings ▸ Custom CSS, turn on "Apply custom CSS" and Save.
 * Everything here is commented out: remove the comment marks around a rule to use it.
 */

/* ---------- Colors ----------
 * Each color is three numbers, red green blue (0–255), separated by spaces.
 */
/*
:root {
  --ink: 22 22 22;       background of the pages
  --panel: 32 32 32;     cards, the bottom bar, sheets
  --surface: 44 44 44;   buttons and chips
  --line: 58 58 58;      borders and dividers
  --brand: 227 38 43;    the accent: Subscribe, progress, highlights
  --mute: 154 154 154;   secondary text
  --zoom: 1;             scales the whole panel (e.g. 1.1)
}
*/

/* ---------- Parts of the panel ----------
 *  #app              the whole panel
 *  #nav              the bottom bar
 *  #mini             the mini player above the bottom bar
 *  .sticky-head      page headers (Tube logo, title, account)
 *  #v-home           Home            #v-explore   Explore
 *  #v-channels       Channels        #v-channel   one channel's page
 *  #v-library        Library         #v-settings  Settings
 *  #v-watch          the watch page
 *  #stage            the player       #controls   the player's controls
 *  #tools            Loop / Autoplay / Audio under the player
 *  #watchInfo        title, channel and the action row
 *  #watchActions     Like, Copy link, Save, Playlist, Download
 *  #comments         comments (or live chat on a live stream)
 *  #chatList         live chat messages
 *  #watchMore        more videos under the player
 *  #lofi             Lofi mode        #lofiViz    the visualizer
 *  #searchOverlay    the search bar   #sheet      the account / playlist sheet
 */

/* ---------- Examples ---------- */

/* Bigger titles on the watch page */
/* #watchInfo .clamp2 { font-size: 16px; } */

/* Three lines of title in lists instead of two */
/* .clamp2 { -webkit-line-clamp: 3; } */

/* Square thumbnails corners */
/* img { border-radius: 4px !important; } */

/* A translucent bottom bar */
/* #nav { background: rgb(var(--panel) / .8); backdrop-filter: blur(12px); } */

/* Hide the comments */
/* #comments { display: none; } */
`

export const SCRIPT_TEMPLATE = `// Tube — custom script template
// Paste what you need into Settings ▸ Custom script, Save, then "Run now" or turn on
// "Run automatically when Tube opens".
//
// The script runs inside the Tube panel, with its access: the page (document, the <video>), your
// YouTube session through Tube, and Tube's storage in Orca. Only run code you understand.
// It runs as an async function, so \`await\` works at the top level.

const video = document.getElementById('video') // the player's <video> element

// ---------- Examples (uncomment to use) ----------

// Always start videos at 1.25x
// video.addEventListener('loadedmetadata', () => (video.playbackRate = 1.25))

// Skip the first 15 seconds of every video
// video.addEventListener('loadedmetadata', () => { if (video.currentTime < 1) video.currentTime = 15 })

// Keyboard shortcuts while the panel has focus: J / L to seek 10 s, K to play or pause
// document.addEventListener('keydown', (e) => {
//   if (e.target.closest('input, textarea')) return
//   if (e.key === 'j') video.currentTime -= 10
//   if (e.key === 'l') video.currentTime += 10
//   if (e.key === 'k') video.paused ? video.play() : video.pause()
// })

// Pause when the panel is hidden from view
// document.addEventListener('visibilitychange', () => { if (document.hidden) video.pause() })

// Make the bottom bar a little transparent
// document.getElementById('nav').style.opacity = '.85'
`
