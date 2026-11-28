# Ledger v132 — Flat Uber-like visual refresh

Based directly on v130; v131 is excluded.

## Replace
`index.html`, `styles.css`, and `sw.js`. `app.js` is included for completeness and is byte-for-byte unchanged from v130. Keep your original `config.js`, `google-picker-config.js`, icons, manifest, and Supabase files unchanged.

## Changes
- Flat black/white/charcoal visual system, no gradients, glass blur, shadows, or decorative animations.
- Existing Ledger icon displayed in a small masthead on application pages.
- Restyled Home, Expenses, Bill Splitter, Routes, Settings, forms, cards, and dock.
- iOS/macOS keep the native Apple system font; Android and other non-Apple devices use Inter (existing v130 font loader).
- All original element IDs, event handler targets, logic, and authentication methods are preserved.
- Accent background colors are neutralized on main navigation and primary controls to match the user-approved monochrome direction. Financial data colors stay intact.

The mockup's extra navigation tabs, different sample amounts, and notification bell were not added.
