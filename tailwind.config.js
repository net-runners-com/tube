const v = (name) => `rgb(var(--${name}) / <alpha-value>)`
module.exports = {
  content: ['./panel/index.html', './panel/app.js'],
  theme: {
    extend: {
      // theme tokens are CSS variables (space-separated RGB), set by the Theme settings
      colors: { ink: v('ink'), panel: v('panel'), surface: v('surface'), line: v('line'), brand: v('brand'), mute: v('mute') }
    }
  }
}
