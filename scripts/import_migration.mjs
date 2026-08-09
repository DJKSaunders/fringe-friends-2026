import fs from "node:fs/promises";

const [migrationPath, configPath] = process.argv.slice(2);
if (!configPath) throw new Error("Usage: import_migration.mjs MIGRATION.json CONFIG.json");

const migration = JSON.parse(await fs.readFile(migrationPath, "utf8"));
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const groupId = config.groupId;
const projectId = config.projectId;
const apiKey = config.apiKey;

const authResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ returnSecureToken: true }),
});
if (!authResponse.ok) throw new Error(`Anonymous authentication failed: ${await authResponse.text()}`);
const { idToken } = await authResponse.json();

function firestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  return { stringValue: String(value) };
}

function write(collectionName, item) {
  return {
    update: {
      name: `projects/${projectId}/databases/(default)/documents/groups/${groupId}/${collectionName}/${encodeURIComponent(item.id)}`,
      fields: Object.fromEntries(Object.entries(item).map(([key, value]) => [key, firestoreValue(value)])),
    },
  };
}

const writes = [
  ...migration.people.map(item => write("people", item)),
  ...migration.plans.map(item => write("plans", item)),
  ...migration.activity.map(item => write("activity", item)),
];
const response = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`, {
  method: "POST",
  headers: { "authorization": `Bearer ${idToken}`, "content-type": "application/json" },
  body: JSON.stringify({ writes }),
});
if (!response.ok) throw new Error(`Firestore import failed: ${await response.text()}`);
console.log(`Imported ${migration.people.length} people and ${migration.plans.length} plans into ${groupId}.`);
