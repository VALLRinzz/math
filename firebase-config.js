// Ganti nilai di bawah dengan konfigurasi aplikasi web Firebase milikmu.
// Firebase Console > Project settings > General > Your apps > SDK setup and configuration.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCWh7L1Wvogr5Lr5RwK6toSS25PnGeOiWU",
  authDomain: "math-battle-62f0d.firebaseapp.com",
  databaseURL: "https://math-battle-62f0d-default-rtdb.firebaseio.com/",
  projectId: "math-battle-62f0d",
  storageBucket: "math-battle-62f0d.firebasestorage.app",
  messagingSenderId: "373593384776",
  appId: "1:373593384776:web:7ee87de723b2d86f76f57d"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
