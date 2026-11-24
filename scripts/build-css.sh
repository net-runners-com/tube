#!/bin/sh
# Rebuilds panel/app.css from panel/tailwind.css (the panel frame cannot load the Tailwind CDN).
cd "$(dirname "$0")/.." && npx tailwindcss -c tailwind.config.js -i panel/tailwind.css -o panel/app.css
