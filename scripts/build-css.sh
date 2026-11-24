#!/bin/sh
# Rebuilds panel/app.css from panel/tailwind.css (the panel frame cannot load the Tailwind CDN).
cd "$(dirname "$0")/.." && npx -y tailwindcss@3.4.17 -c tailwind.config.js -i panel/tailwind.css -o panel/app.css
