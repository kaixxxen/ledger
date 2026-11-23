# Ledger v125 — Itinerary modal correction

Baseline: v124. Replace index.html, styles.css, app.js and sw.js. Do not touch config.js, credentials or SQL.

- Remove overview icon; two aligned equal-width overview cells with compact typography.
- Click opens full combined itinerary dialog.
- PDF icon/text beside dialog title opens device print/share workflow for Save as PDF. No direct filesystem write is possible from an ordinary webpage.
- Preserves route and stop storage, authentication and calculations.
