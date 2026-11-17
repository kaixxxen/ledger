# Ledger v118 — Bill avatar alignment & card size

Built on the user-approved v117 Bill Splitter avatar update.

Changes are CSS-only: center images in avatar boxes across the picker, editor, and bill detail header; enlarge illustrated avatars to 48 × 48 px on bill cards (46 × 46 px on narrow phones) to visually span the two rows of card text; preserve space from the card edge and text; keep tiles transparent. The picker tile sizes, spacing, opened-bill header, buttons, and all other pages are unchanged.

`app.js` and `index.html` are byte-for-byte identical to v117. `sw.js` only changes its cache key so browsers fetch updated CSS. No auth, Supabase, route, or finance code was modified.

Replace **styles.css** and **sw.js** in your GitHub repository. Full app files are included for convenience; do not change your existing `config.js` or `google-picker-config.js`. Retain a copy of v117 for rollback.
