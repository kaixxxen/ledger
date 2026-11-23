Ledger v126 — itinerary timeline and PDF fix

Based on v125. Replace app.js, index.html, styles.css, sw.js on GitHub.

Changes:
- Clean dark timeline cards organized by day (ticket and stop entries in chronological order).
- Reuses existing application font, sizes, variables, colors and modal controls.
- Fixes blank PDF exports: the printable sheet is moved outside the hidden <main> element into body before calling print.
- PDF print styles use a simple white document with selectable text and keep activities together.
- Existing auth, Supabase calls, routes, bills, and data schema are unchanged.

On iOS, use PDF button, then share or save the print preview to Files; desktop: Save as PDF printer.
