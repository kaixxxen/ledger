Ledger v127 — Route/Bill connection and targeted UI fixes.

Replace app.js, index.html, styles.css and sw.js on GitHub. Keep config.js, google-picker-config.js, schema.sql and Supabase settings unchanged. No new tables needed.

Changes: flat floating bill actions; create-or-link a bill from Route (new bill uses route name, avatar and travelers); synchronize travelers in both editors for routes/bills owned by the same account; guard historical expenses and settlements from unsafe participant deletion; compact one-line Stop datetime values using native date/time pickers; more visible pastel accent controls; a compact Back to Route button in bills opened from Routes.

Notes: Participant removal is blocked if they are referenced by historical expenses, custom shares or payments. Existing historical transactions are NOT automatically redistributed; changing them silently would alter balances. Confirmed cloud membership changes require existing owner permissions/RPCs. Local unit assertions and JavaScript syntax checks passed; live OAuth/Supabase/mobile browser end-to-end tests were not possible in this environment. Keep a rollback backup of v126.
