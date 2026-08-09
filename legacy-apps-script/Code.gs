const SHEETS = Object.freeze({
  shows: 'Shows',
  friends: 'Friends',
  plans: 'Plans'
});

const STATUSES = Object.freeze([
  'want_to_see',
  'want_to_see_date',
  'booked',
  'seen'
]);

const DATE_MIN = '2026-08-03';
const DATE_MAX = '2026-08-31';
const FRIEND_COLORS = Object.freeze(['#ef476f', '#118ab2', '#06a77d', '#7b61a8', '#d97706', '#3a86ff', '#b23a48', '#52796f']);

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Fringe Friends 2026')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Run once after setting CSV_FILE_ID in Project Settings > Script Properties.
 * The CSV must have title and performer columns.
 */
function setup() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('This script must be bound to a Google Sheet.');
  }
  PropertiesService.getScriptProperties().setProperty('DATABASE_SPREADSHEET_ID', spreadsheet.getId());

  ensureSheet_(SHEETS.shows, ['show_id', 'title', 'performer']);
  ensureSheet_(SHEETS.friends, ['friend_id', 'display_name', 'display_order', 'active', 'initials', 'color']);
  ensureSheet_(SHEETS.plans, ['friend_id', 'show_id', 'status', 'planned_date', 'updated_at', 'performance_time']);
  importShowsFromDriveCsv();

  const friends = spreadsheet.getSheetByName(SHEETS.friends);
  if (friends.getLastRow() === 1) {
    friends.getRange(2, 1, 1, 6).setValues([['friend_001', 'Replace with a friend', 1, true, 'RF', FRIEND_COLORS[0]]]);
  }
  ensureFriendColumns_();
  ensurePlanColumns_();
  formatSheets_();
}

function importShowsFromDriveCsv() {
  const fileId = PropertiesService.getScriptProperties().getProperty('CSV_FILE_ID');
  if (!fileId) {
    throw new Error('Set CSV_FILE_ID in Project Settings > Script Properties first.');
  }

  const file = DriveApp.getFileById(fileId);
  let records;
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    const sourceSheets = SpreadsheetApp.openById(fileId).getSheets();
    const sourceSheet = sourceSheets.find(sheet => {
      if (sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return false;
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn())
        .getDisplayValues()[0]
        .map(value => String(value).trim().toLowerCase());
      return headers.includes('title') && headers.includes('performer');
    });
    if (!sourceSheet) {
      throw new Error(
        `No tab in "${file.getName()}" has title and performer columns in row 1. ` +
        'Check that CSV_FILE_ID refers to the show catalogue rather than the database spreadsheet.'
      );
    }
    records = sourceSheet.getDataRange().getDisplayValues();
  } else {
    const csvText = file.getBlob().getDataAsString('UTF-8').replace(/^\uFEFF/, '');
    try {
      records = Utilities.parseCsv(csvText);
    } catch (error) {
      throw new Error(
        `Google could not parse "${file.getName()}" as CSV. ` +
        'Confirm that CSV_FILE_ID refers to the CSV itself, or open the CSV in Google Sheets and use the converted Google Sheet ID. ' +
        `Original error: ${error.message}`
      );
    }
  }
  if (records.length < 2) throw new Error('The CSV contains no show rows.');

  const headers = records[0].map(value => String(value).trim().toLowerCase());
  const titleIndex = headers.indexOf('title');
  const performerIndex = headers.indexOf('performer');
  if (titleIndex < 0 || performerIndex < 0) {
    throw new Error('The CSV must contain title and performer columns.');
  }

  const seen = new Set();
  const shows = records.slice(1).map((record, index) => {
    const title = String(record[titleIndex] || '').trim();
    const performer = String(record[performerIndex] || '').trim();
    if (!title || !performer) return null;
    const fingerprint = `${title.toLocaleLowerCase()}\u0000${performer.toLocaleLowerCase()}`;
    if (seen.has(fingerprint)) return null;
    seen.add(fingerprint);
    return [`show_${String(index + 1).padStart(4, '0')}`, title, performer];
  }).filter(Boolean);

  const sheet = ensureSheet_(SHEETS.shows, ['show_id', 'title', 'performer']);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 3).setValues([['show_id', 'title', 'performer']]);
  if (shows.length) sheet.getRange(2, 1, shows.length, 3).setValues(shows);
  sheet.setFrozenRows(1);
  return { imported: shows.length };
}

function getInitialData() {
  ensureFriendColumns_();
  ensurePlanColumns_();
  markPastBookingsSeen_();
  return {
    shows: getPlanShows_(),
    friends: readObjects_(SHEETS.friends)
      .filter(row => parseBoolean_(row.active))
      .sort((a, b) => Number(a.display_order) - Number(b.display_order))
      .map(row => ({
        id: row.friend_id,
        name: row.display_name,
        initials: row.initials || makeInitials_(row.display_name),
        color: validColor_(row.color) ? String(row.color) : FRIEND_COLORS[0]
      })),
    plans: readObjects_(SHEETS.plans).map(serialisePlan_),
    dateMin: DATE_MIN,
    dateMax: DATE_MAX
  };
}

function autoMarkPastBookingsSeen() {
  return { updated: markPastBookingsSeen_() };
}

function installDailySeenTrigger() {
  const handler = 'autoMarkPastBookingsSeen';
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === handler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger(handler)
    .timeBased()
    .atHour(1)
    .everyDays(1)
    .inTimezone('Europe/London')
    .create();
  return { installed: true, handler };
}

function markPastBookingsSeen_() {
  const sheet = getDatabase_().getSheetByName(SHEETS.plans);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rowCount = sheet.getLastRow() - 1;
    ensurePlanColumns_();
    const range = sheet.getRange(2, 1, rowCount, 6);
    const rows = range.getValues();
    const today = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd');
    let updated = 0;
    rows.forEach(row => {
      let plannedDate = row[3] || '';
      if (plannedDate instanceof Date) plannedDate = Utilities.formatDate(plannedDate, 'Europe/London', 'yyyy-MM-dd');
      else plannedDate = String(plannedDate).trim();
      if (String(row[2]) === 'booked' && plannedDate && plannedDate < today) {
        row[2] = 'seen';
        row[4] = new Date();
        updated += 1;
      }
    });
    if (updated) range.setValues(rows);
    return updated;
  } finally {
    lock.releaseLock();
  }
}

function addFriend(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid person details.');
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  const initials = String(input.initials || makeInitials_(name)).trim().toUpperCase();
  const color = String(input.color || '').trim().toLowerCase();
  if (name.length < 1 || name.length > 60) throw new Error('Name must be between 1 and 60 characters.');
  if (!/^[A-Z0-9]{1,3}$/.test(initials)) throw new Error('Initials must contain 1–3 letters or numbers.');
  if (!validColor_(color)) throw new Error('Choose a valid colour.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureFriendColumns_();
    const sheet = getDatabase_().getSheetByName(SHEETS.friends);
    const existing = readObjects_(SHEETS.friends);
    if (existing.some(row => String(row.display_name).trim().toLowerCase() === name.toLowerCase())) {
      throw new Error('A person with that name already exists.');
    }
    if (existing.some(row => parseBoolean_(row.active) && String(row.initials).trim().toUpperCase() === initials)) {
      throw new Error('Those initials are already in use.');
    }
    const displayOrder = existing.reduce((maximum, row) => Math.max(maximum, Number(row.display_order) || 0), 0) + 1;
    const id = `friend_${Utilities.getUuid().replace(/-/g, '').slice(0, 12)}`;
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, 6).setValues([[id, name, displayOrder, true, initials, color]]);
    return { id, name, initials, color };
  } finally {
    lock.releaseLock();
  }
}

function updateFriend(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid person details.');
  const id = String(input.id || '').trim();
  const name = String(input.name || '').trim().replace(/\s+/g, ' ');
  const initials = String(input.initials || makeInitials_(name)).trim().toUpperCase();
  const color = String(input.color || '').trim().toLowerCase();
  if (!id) throw new Error('Choose a person to edit.');
  if (name.length < 1 || name.length > 60) throw new Error('Name must be between 1 and 60 characters.');
  if (!/^[A-Z0-9]{1,3}$/.test(initials)) throw new Error('Initials must contain 1–3 letters or numbers.');
  if (!validColor_(color)) throw new Error('Choose a valid colour.');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensureFriendColumns_();
    const sheet = getDatabase_().getSheetByName(SHEETS.friends);
    const rows = sheet.getDataRange().getValues();
    const targetIndex = rows.findIndex((row, index) => index > 0 && String(row[0]) === id);
    if (targetIndex < 1) throw new Error('That person no longer exists.');
    const existing = readObjects_(SHEETS.friends).filter(row => String(row.friend_id) !== id);
    if (existing.some(row => String(row.display_name).trim().toLowerCase() === name.toLowerCase())) throw new Error('A person with that name already exists.');
    if (existing.some(row => parseBoolean_(row.active) && String(row.initials).trim().toUpperCase() === initials)) throw new Error('Those initials are already in use.');
    const rowNumber = targetIndex + 1;
    sheet.getRange(rowNumber, 2).setValue(name);
    sheet.getRange(rowNumber, 5, 1, 2).setValues([[initials, color]]);
    return { id, name, initials, color };
  } finally {
    lock.releaseLock();
  }
}

function searchShows(query, requestedLimit) {
  const sheet = getDatabase_().getSheetByName(SHEETS.shows);
  if (!sheet) throw new Error('Shows sheet is missing. Run setup().');
  const total = Math.max(0, sheet.getLastRow() - 1);
  const limit = Math.min(200, Math.max(1, Number(requestedLimit) || 30));
  const needle = String(query || '').trim().toLocaleLowerCase();
  const rows = total ? sheet.getRange(2, 1, total, 2).getDisplayValues() : [];
  const matching = rows.filter(row => !needle || String(row[1]).toLocaleLowerCase().includes(needle));
  return {
    shows: matching.slice(0, limit).map(row => ({ id: row[0], title: row[1] })),
    matched: matching.length,
    total,
    returned: Math.min(limit, matching.length)
  };
}

function getPlanShows_() {
  const showIds = new Set(readObjects_(SHEETS.plans).map(row => String(row.show_id)));
  if (!showIds.size) return [];
  const sheet = getDatabase_().getSheetByName(SHEETS.shows);
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  if (!rowCount) return [];
  return sheet.getRange(2, 1, rowCount, 2).getDisplayValues()
    .filter(row => showIds.has(String(row[0])))
    .map(row => ({ id: row[0], title: row[1] }));
}

function savePlan(input) {
  const plan = validatePlan_(input);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    ensurePlanColumns_();
    const sheet = getDatabase_().getSheetByName(SHEETS.plans);
    const rows = sheet.getDataRange().getValues();
    let targetRow = -1;
    for (let i = 1; i < rows.length; i += 1) {
      if (String(rows[i][0]) === plan.friendId && String(rows[i][1]) === plan.showId) {
        targetRow = i + 1;
        break;
      }
    }
    const values = [[plan.friendId, plan.showId, plan.status, plan.date || '', new Date(), plan.time || '']];
    if (targetRow > 0) sheet.getRange(targetRow, 1, 1, 6).setValues(values);
    else sheet.getRange(sheet.getLastRow() + 1, 1, 1, 6).setValues(values);
    return serialisePlan_({
      friend_id: plan.friendId,
      show_id: plan.showId,
      status: plan.status,
      planned_date: plan.date,
      updated_at: values[0][4],
      performance_time: plan.time
    });
  } finally {
    lock.releaseLock();
  }
}

function deletePlan(friendId, showId) {
  validateEntity_(SHEETS.friends, 'friend_id', friendId, 'friend');
  validateEntity_(SHEETS.shows, 'show_id', showId, 'show');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getDatabase_().getSheetByName(SHEETS.plans);
    const rows = sheet.getDataRange().getValues();
    for (let i = rows.length - 1; i >= 1; i -= 1) {
      if (String(rows[i][0]) === String(friendId) && String(rows[i][1]) === String(showId)) {
        sheet.deleteRow(i + 1);
      }
    }
    return { deleted: true, friendId: String(friendId), showId: String(showId) };
  } finally {
    lock.releaseLock();
  }
}

function validatePlan_(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid plan.');
  const friendId = String(input.friendId || '').trim();
  const showId = String(input.showId || '').trim();
  const status = String(input.status || '').trim();
  const date = String(input.date || '').trim();
  const time = String(input.time || '').trim();
  validateEntity_(SHEETS.friends, 'friend_id', friendId, 'friend');
  validateEntity_(SHEETS.shows, 'show_id', showId, 'show');
  if (!STATUSES.includes(status)) throw new Error('Invalid status.');
  if ((status === 'want_to_see_date' || status === 'booked') && !date) {
    throw new Error('This status requires a date.');
  }
  if (status === 'want_to_see' && date) throw new Error('General interest cannot have a date.');
  if (status === 'want_to_see' && time) throw new Error('General interest cannot have a performance time.');
  if (time && !date) throw new Error('Choose a date before adding a performance time.');
  if (time) {
    const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match || Number(match[2]) % 5 !== 0) throw new Error('Performance time must use a five-minute interval.');
  }
  if (date && (!/^2026-08-(0[3-9]|1\d|2\d|3[01])$/.test(date) || date < DATE_MIN || date > DATE_MAX)) {
    throw new Error('Date must be between 3 and 31 August 2026.');
  }
  return { friendId, showId, status, date, time };
}

function validateEntity_(sheetName, keyName, value, label) {
  if (!value || !readObjects_(sheetName).some(row => String(row[keyName]) === String(value))) {
    throw new Error(`Unknown ${label}.`);
  }
}

function serialisePlan_(row) {
  let date = row.planned_date || '';
  if (date instanceof Date) date = Utilities.formatDate(date, 'Europe/London', 'yyyy-MM-dd');
  let time = row.performance_time || '';
  if (time instanceof Date) time = Utilities.formatDate(time, 'Europe/London', 'HH:mm');
  return {
    friendId: String(row.friend_id),
    showId: String(row.show_id),
    status: String(row.status),
    date: String(date),
    time: String(time),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || '')
  };
}

function readObjects_(sheetName) {
  const sheet = getDatabase_().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(String);
  return values.filter(row => row.some(value => value !== '')).map(row =>
    headers.reduce((object, header, index) => {
      object[header] = row[index];
      return object;
    }, {})
  );
}

function ensureSheet_(name, headers) {
  const spreadsheet = getDatabase_();
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function ensureFriendColumns_() {
  const sheet = ensureSheet_(SHEETS.friends, ['friend_id', 'display_name', 'display_order', 'active', 'initials', 'color']);
  const requiredHeaders = ['friend_id', 'display_name', 'display_order', 'active', 'initials', 'color'];
  sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  if (!rowCount) return sheet;

  const values = sheet.getRange(2, 1, rowCount, 6).getDisplayValues();
  const usedInitials = new Set();
  const identityValues = values.map((row, index) => {
    const preferred = String(row[4] || makeInitials_(row[1])).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || '?';
    let unique = preferred;
    let suffix = 2;
    while (usedInitials.has(unique)) {
      unique = suffix < 10 ? `${preferred.slice(0, 2)}${suffix}`.slice(0, 3) : `${preferred.slice(0, 1)}${suffix}`.slice(0, 3);
      suffix += 1;
    }
    usedInitials.add(unique);
    return [unique, validColor_(row[5]) ? row[5].toLowerCase() : FRIEND_COLORS[index % FRIEND_COLORS.length]];
  });
  sheet.getRange(2, 5, rowCount, 2).setValues(identityValues);
  return sheet;
}

function ensurePlanColumns_() {
  const headers = ['friend_id', 'show_id', 'status', 'planned_date', 'updated_at', 'performance_time'];
  const sheet = ensureSheet_(SHEETS.plans, headers);
  const previousTimeHeader = sheet.getRange(1, 6).getDisplayValue();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (previousTimeHeader !== 'performance_time') {
    sheet.getRange(2, 6, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('@');
  }
  return sheet;
}

function makeInitials_(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function validColor_(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ''));
}

function parseBoolean_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function getDatabase_() {
  const properties = PropertiesService.getScriptProperties();
  const spreadsheetId = properties.getProperty('DATABASE_SPREADSHEET_ID');
  if (spreadsheetId) return SpreadsheetApp.openById(spreadsheetId);

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('Database spreadsheet is not configured. Run setup() from the bound spreadsheet project.');
  }
  properties.setProperty('DATABASE_SPREADSHEET_ID', active.getId());
  return active;
}

function formatSheets_() {
  Object.values(SHEETS).forEach(name => {
    const sheet = getDatabase_().getSheetByName(name);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#252147').setFontColor('#ffffff');
    sheet.autoResizeColumns(1, sheet.getLastColumn());
  });
}
