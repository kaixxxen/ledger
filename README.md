# Ledger v128 — Itinerary timeline polish

Based on v127; no changes to authentication, Supabase credentials, or schema.

- One unified card with a continuous left rail for all tickets and stops on each day.
- Smaller typography for daily headings and rows; main modal title remains the largest.
- Prevents ticket labels from repeating when the saved ticket name equals its displayed heading.
- Distinct monochrome SVG icons for plane, bus, train, place, lodging, food, transport, and activity.
- Preselects all travelers when adding a new stop. Existing stop selections are preserved; legacy empty arrays display all selected.
- Temporarily sets the browser document title to the route name with spaces replaced by underscores during PDF export, then restores Ledger. The browser/OS controls the final suggested filename; PDF extension is added by the save dialog.

Replace app.js, styles.css and sw.js. index.html is included unchanged for completeness.
No SQL changes. Live Google/Supabase tests were not performed.
