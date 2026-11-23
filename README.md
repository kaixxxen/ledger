# Ledger v124 — Itinerary Summary

Baseline: Ledger v123. Replace `index.html`, `styles.css`, `app.js`, and `sw.js`. Do not replace `config.js` or any Google credentials.

- The second route overview statistic has become **View Itinerary**.
- The modal merges active tickets and active stops in ascending date/time order, day by day. Undated items follow dated items.
- The PDF button opens your browser's native Print dialogue. On desktop choose **Save as PDF**; on iPhone/iPad use the print preview's Share/Save to Files flow where available. It cannot silently write to arbitrary local folders.
- Does not alter storage or Supabase schemas.
