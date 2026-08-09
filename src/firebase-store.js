import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-auth.js";
import { collection, deleteDoc, doc, getFirestore, onSnapshot, setDoc } from "https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore.js";
import { firebaseConfig, groupId } from "../firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const stable = value => JSON.stringify(value, Object.keys(value).sort());

function waitForAuth() {
  return new Promise((resolve, reject) => {
    const stop = onAuthStateChanged(auth, user => {
      if (user) {
        stop();
        resolve(user);
      }
    }, reject);
    if (!auth.currentUser) signInAnonymously(auth).catch(reject);
  });
}

export async function connectFirebase(onData, onError) {
  await waitForAuth();
  const collections = {
    people: collection(db, "groups", groupId, "people"),
    plans: collection(db, "groups", groupId, "plans"),
    activity: collection(db, "groups", groupId, "activity"),
  };
  const remote = { people: null, plans: null, activity: null };
  const announced = { people: new Map(), plans: new Map(), activity: new Map() };

  function publishIfReady() {
    if (Object.values(remote).every(Boolean)) {
      onData({
        people: remote.people,
        plans: remote.plans,
        activity: remote.activity.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50),
      });
    }
  }

  for (const [name, reference] of Object.entries(collections)) {
    onSnapshot(reference, snapshot => {
      remote[name] = snapshot.docs.map(item => item.data());
      announced[name] = new Map(remote[name].map(item => [item.id, stable(item)]));
      publishIfReady();
    }, onError);
  }

  return {
    async sync(snapshot) {
      const operations = [];
      for (const name of Object.keys(collections)) {
        const desired = new Map(snapshot[name].map(item => [item.id, item]));
        for (const [id, item] of desired) {
          if (announced[name].get(id) !== stable(item)) {
            operations.push(setDoc(doc(collections[name], id), item));
          }
        }
        for (const id of announced[name].keys()) {
          if (!desired.has(id)) operations.push(deleteDoc(doc(collections[name], id)));
        }
      }
      await Promise.all(operations);
    }
  };
}
