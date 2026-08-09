# Fringe Friends 2026

A mobile-first group planner for the 2026 Edinburgh Festival Fringe. The site is hosted on GitHub Pages and is being migrated from the preserved Google Apps Script prototype to Firebase.

## Current build

The application currently includes:

- 4,463 official Fringe listings from the 9 August 2026 Festival City export;
- title-only catalogue search in batches of 40;
- group plans with multiple attendees;
- interested, specific-date, booked and seen statuses;
- optional five-minute performance times;
- a compact personal view and chronological Today view;
- schedule-conflict warnings;
- optimistic updates and five-second undo;
- a recent group activity feed;
- horizontal date navigation from 3–31 August;
- responsive mobile and desktop layouts.

Until Firebase is configured, people and plans are stored in the current browser using `localStorage`. This is suitable for interface testing but does not yet share changes between devices.

## Run locally

From this directory, run:

```bash
python3 -m http.server 8765
```

Then open <http://127.0.0.1:8765/>.

Opening `index.html` directly will not work because browsers block the catalogue fetch from a local file URL.

## Catalogue

The deployed site reads `data/shows.json`. It contains only an internal event ID and title; no descriptions, venues or prices are shipped.

To regenerate it from a Festival City Excel export:

```bash
python3 scripts/build_catalog.py /path/to/events.xlsx data/shows.json
```

The script keeps only records whose festival is `Edinburgh Festival Fringe` and year is `2026`.

## Firebase setup — next phase

1. Create a Firebase project.
2. Enable Firestore Database.
3. Enable Anonymous Authentication.
4. Add a Firebase web application.
5. Copy `firebase-config.example.js` to `firebase-config.js`.
6. Paste the web configuration supplied by Firebase.
7. Add and deploy the supplied Firestore security rules when they are introduced in the Firebase phase.

Firebase web configuration identifies a Firebase project but does not grant administrative access. Database protection comes from Authentication and Firestore Security Rules.

## Migrate the Apps Script records

Generate the private migration package from a complete Google Sheet Excel export:

```bash
node scripts/build_migration.mjs /path/to/export.xlsx data/shows.json migration-data.json migration-report.json
```

The migration resolves legacy show IDs to titles, maps those titles to the refreshed catalogue, and combines identical individual records into shared plans. Both generated files are deliberately ignored by Git and must never be committed to the public repository.

## Legacy prototype

The complete Apps Script version and its original catalogue are preserved in `legacy-apps-script/`.
