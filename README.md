# Ledger v119 — Route and Stop Date Ranges

Based on the exact latest Ledger files uploaded November 23, 2026. The existing application design, authentication handling, bill features, and database access mechanisms are retained.

## Files to update in your GitHub repository

Replace **app.js**, **index.html**, **styles.css**, and **sw.js** with the corresponding files from this ZIP. Do not rename the files. Keep your existing `config.js`, `google-picker-config.js`, icons, manifest, and other files unchanged.

## Changes

- Plan/Edit Route: `End Date` next to `Start Date`, with `Linked Bill` on its own full-width row. Both dates survive editing and are stored in the local route JSON or the `data` JSONB used by shared routes. Empty end dates remain supported for older routes.
- Route card and header: show a compact start–end date range when an end date has been selected. Routes with no end date show the original start date as before.
- Add/Edit Stop: remove the standalone Date row. Group the existing start date and start time under `Start Date & Time`; add a new end-date control alongside the existing end-time control under `End Date and Time`. The estimated cost field is still present.
- Stop records: retain the existing `date`, `time`, and `endTime` properties, and add only `endDate`. Existing stops with an end time and no end date are interpreted as same-day. Blank time values are preserved.
- Stops itinerary and details: display multi-day ranges when end date differs from start date, including overnight stops.
- Validation: do not allow end dates before start dates or, on the same day, an end time earlier than the start time.
- Service worker cache: updated to `ledger-v119-route-date-ranges` to avoid stale UI.

## Database

No SQL migration is required for these fields. Ledger's shared-route `ledger_routes.data` is JSONB; both dates live inside that existing JSON document. The separate `schema.sql` uploaded with the project was not changed.

## Verification

- Node syntax checks: `app.js` and `sw.js` passed.
- Headless Chromium local-mode interaction tests at widths of 320px, 390px, 768px, and 1280px passed, including route save, overnight stop save, display of the date range, no page horizontal overflow, and no JavaScript page errors.
- Editing a saved route and stop restored their date values. Tests of invalid chronological date ranges prevented saving.
- Google OAuth and live Supabase shared-route saves were not tested against the production service.

Keep your previous production release as a rollback copy until you have tested v119 in your account.
