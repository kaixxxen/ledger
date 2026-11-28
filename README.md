# Ledger v130 — Remove notifications

This package is based directly on v129.

Changed:
- Removed the notification bell, inbox panel, dismiss overlay and alert dot.
- Removed notification UI initialization, observers, local inbox generation, and shared-bill change notification snapshots.
- Restored normal header spacing with no reserved bell area.
- Preserved card due-date reminders, route/bill synchronization, login, modals and financial data.
- Bumped service-worker cache to v130.

Replace `app.js`, `index.html`, `styles.css`, and `sw.js`. Keep your existing configuration files, database and credentials unchanged. Existing notification-only localStorage entries are left untouched rather than wiping browser storage.
