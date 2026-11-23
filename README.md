# Ledger v120 — Restore classic Bill Splitter emoji avatars

This release starts from the v119 Route/Stop date update (not v116).

- Original set of 30 animal emoji choices restored in Bill Splitter.
- Original emoji picker grid and avatar sizing restored by removing v117/v118 illustration-only CSS.
- Original Bill Splitter card and opened-bill header avatar sizing restored.
- Existing saved `avatar_XX` illustrations display as standard emoji via a compatibility mapping, without changing stored data until the bill is edited and saved.
- Custom emojis and route emoji picker retained.
- v119 Route End Date, Stop Start Date & Time, End Date & Time, layouts and saving functions preserved.
- No SQL, Supabase, financial logic or authentication changes. `config.js` unchanged; do not replace it.

Replace `app.js`, `styles.css`, `index.html`, `sw.js` at the website root. Leave `config.js` and `google-picker-config.js` untouched. Test in local mode and your real deployment before relying on this update.
