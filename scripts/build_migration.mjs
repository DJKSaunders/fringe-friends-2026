import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [sourcePath, cataloguePath, outputPath, reportPath] = process.argv.slice(2);
if (!reportPath) {
  throw new Error("Usage: build_migration.mjs SOURCE.xlsx SHOWS.json OUTPUT.json REPORT.json");
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(sourcePath));
const catalogue = JSON.parse(await fs.readFile(cataloguePath, "utf8")).shows;

function rows(sheetName) {
  const values = workbook.worksheets.getItem(sheetName).getUsedRange(true).values;
  const headers = values[0].map(String);
  return values.slice(1).filter(row => row.some(value => value !== null && value !== "")).map(row =>
    Object.fromEntries(headers.map((header, index) => [header, row[index]]))
  );
}

function normaliseTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-GB");
}

function excelDate(value, includeTime = false) {
  if (value === null || value === "" || value === undefined) return null;
  const milliseconds = Math.round((Number(value) - 25569) * 86400 * 1000);
  const iso = new Date(milliseconds).toISOString();
  return includeTime ? iso : iso.slice(0, 10);
}

const oldShows = new Map(rows("Shows").map(row => [String(row.show_id), String(row.title).trim()]));
const catalogueByTitle = new Map();
for (const show of catalogue) {
  const key = normaliseTitle(show.title);
  const matches = catalogueByTitle.get(key) ?? [];
  matches.push(show);
  catalogueByTitle.set(key, matches);
}

const titleAliases = new Map([
  [normaliseTitle("Hard to Swallow: Reuben Kaye"), normaliseTitle("Reuben Kaye: Hard to Swallow")],
]);

const friends = rows("Friends")
  .filter(row => row.active !== false)
  .sort((a, b) => Number(a.display_order) - Number(b.display_order))
  .map(row => ({
    id: String(row.friend_id),
    name: String(row.display_name).trim(),
    initials: String(row.initials).trim().toUpperCase(),
    colour: String(row.color).trim(),
    displayOrder: Number(row.display_order),
    active: true,
  }));

const statusMap = {
  want_to_see: "interested",
  want_to_see_date: "dated",
  booked: "booked",
  seen: "seen",
};
const groups = new Map();
const unmatched = [];
const ambiguous = [];

for (const row of rows("Plans")) {
  const oldShowId = String(row.show_id);
  const title = oldShows.get(oldShowId);
  const normalised = normaliseTitle(title);
  const matches = catalogueByTitle.get(titleAliases.get(normalised) ?? normalised) ?? [];
  if (!title || matches.length === 0) {
    unmatched.push({ oldShowId, title: title ?? null, friendId: String(row.friend_id) });
    continue;
  }
  if (matches.length > 1) {
    ambiguous.push({ oldShowId, title, candidateIds: matches.map(show => show.id), friendId: String(row.friend_id) });
    continue;
  }

  const status = statusMap[String(row.status)];
  if (!status) throw new Error(`Unsupported status: ${row.status}`);
  const date = excelDate(row.planned_date);
  const time = row.performance_time ? String(row.performance_time).slice(0, 5) : null;
  const key = JSON.stringify([matches[0].id, status, date, time]);
  const existing = groups.get(key) ?? {
    id: crypto.randomUUID(),
    showId: matches[0].id,
    status,
    date,
    time,
    attendeeIds: [],
    updatedAt: excelDate(row.updated_at, true),
    updatedBy: String(row.friend_id),
  };
  const friendId = String(row.friend_id);
  if (!existing.attendeeIds.includes(friendId)) existing.attendeeIds.push(friendId);
  const updatedAt = excelDate(row.updated_at, true);
  if (updatedAt && (!existing.updatedAt || updatedAt > existing.updatedAt)) {
    existing.updatedAt = updatedAt;
    existing.updatedBy = friendId;
  }
  groups.set(key, existing);
}

function mergeAttendance(target, source) {
  target.attendeeIds = [...new Set([...target.attendeeIds, ...source.attendeeIds])].sort();
  if (!target.time && source.time) target.time = source.time;
  if (String(source.updatedAt) > String(target.updatedAt)) {
    target.updatedAt = source.updatedAt;
    target.updatedBy = source.updatedBy;
  }
}

function consolidateCompatiblePlans(sourcePlans) {
  const buckets = new Map();
  for (const plan of sourcePlans) {
    const key = JSON.stringify([plan.showId, plan.status, plan.date]);
    const bucket = buckets.get(key) ?? [];
    bucket.push({ ...plan, attendeeIds: [...plan.attendeeIds] });
    buckets.set(key, bucket);
  }
  const consolidated = [];
  for (const bucket of buckets.values()) {
    const timed = new Map();
    const untimed = [];
    for (const plan of bucket) {
      if (!plan.time) {
        untimed.push(plan);
      } else if (timed.has(plan.time)) {
        mergeAttendance(timed.get(plan.time), plan);
      } else {
        timed.set(plan.time, plan);
      }
    }
    if (timed.size === 1) {
      const target = [...timed.values()][0];
      untimed.forEach(plan => mergeAttendance(target, plan));
    } else if (untimed.length) {
      const target = untimed.shift();
      untimed.forEach(plan => mergeAttendance(target, plan));
      consolidated.push(target);
    }
    consolidated.push(...timed.values());
  }
  return consolidated;
}

const plans = consolidateCompatiblePlans([...groups.values()]);
const migration = {
  version: 1,
  exportedAt: new Date().toISOString(),
  source: "Google Apps Script workbook export",
  people: friends,
  plans,
  activity: [],
};
const report = {
  sourceFriendRows: friends.length,
  sourcePlanRows: rows("Plans").length,
  migratedPlans: plans.length,
  migratedAttendanceRecords: plans.reduce((total, plan) => total + plan.attendeeIds.length, 0),
  sharedPlans: plans.filter(plan => plan.attendeeIds.length > 1).length,
  unmatched,
  ambiguous,
};

await fs.writeFile(outputPath, JSON.stringify(migration, null, 2) + "\n");
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
