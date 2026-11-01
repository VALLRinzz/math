import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  ref, get, set, update, remove, onValue, runTransaction
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

// ---------- ELEMENTS ----------
const $ = (id) => document.getElementById(id);
const screens = ["authScreen", "homeScreen", "lobbyScreen", "gameScreen", "finishedScreen", "practiceScreen"];

const playerNameInput = $("playerName");
const roomCodeInput = $("roomCodeInput");
const createRoomBtn = $("createRoomBtn");
const joinRoomBtn = $("joinRoomBtn");
const readyBtn = $("readyBtn");
const startBattleBtn = $("startBattleBtn");
const leaveRoomBtn = $("leaveRoomBtn");
const copyCodeBtn = $("copyCodeBtn");
const submitAnswerBtn = $("submitAnswerBtn");
const answerInput = $("answerInput");
const operationSelect = $("operationSelect");
const targetScoreSelect = $("targetScoreSelect");
const difficultySelect = $("difficultySelect");
const answerModeSelect = $("answerModeSelect");
const choiceGrid = $("choiceGrid");
const essayControls = $("essayControls");
const backHomeBtn = $("backHomeBtn");
const exitGameBtn = $("exitGameBtn");
const rematchBtn = $("rematchBtn");
const soundToggle = $("soundToggle");
const practiceOpenBtn = $("practiceOpenBtn");
let soundEnabled = localStorage.getItem("mathBattleSound") !== "off";
let leaderboardUnsubscribe = null;
let lastFinishedMatchId = null;
let rematchResetting = false;
let practiceCurrent = null;

const ROUND_SECONDS = 20;
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let currentUser = null;
let authMode = "login";
let currentRoomCode = null;
let currentRoom = null;
let currentName = "";
let currentRole = null; // "host" or "guest"
let unsubscribeRoom = null;
let timerInterval = null;
let toastTimeout = null;
let processingRound = null;
let hasSubmittedForRound = false;
let busy = false;
let audioContext = null;
let lastCountdownSecond = null;
let lastRenderedRound = null;

// ---------- UI HELPERS ----------
function showScreen(screenId) {
  screens.forEach(id => $(id).classList.toggle("hidden", id !== screenId));
  updateAccountControls();
}

function updateAccountControls() {
  const controls = $("accountControls");
  if (!controls) return;
  const signedIn = !!currentUser;
  controls.classList.toggle("hidden", !signedIn);
  if (signedIn) {
    const fallbackName = currentUser.email?.split("@")[0] || "Pemain";
    $("accountName").textContent = currentName || fallbackName;
  }
}

async function handleLogout() {
  if (!currentUser) return;
  if (!window.confirm("Yakin ingin logout dari akun Math Battle?")) return;
  try {
    stopRoomListener();
    stopTimer();
    if (leaderboardUnsubscribe) {
      leaderboardUnsubscribe();
      leaderboardUnsubscribe = null;
    }
    resetLocalRoom();
    await signOut(auth);
    currentUser = null;
    currentName = "";
    playerNameInput.value = "";
    localStorage.removeItem("mathBattleName");
    updateAccountControls();
    showScreen("authScreen");
    toast("Kamu berhasil logout.");
  } catch (error) {
    console.error(error);
    toast("Logout gagal. Coba periksa koneksi internet.");
  }
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove("show"), 2600);
}

function setBusy(state) {
  busy = state;
  createRoomBtn.disabled = state;
  joinRoomBtn.disabled = state;
}

function cleanName(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 16);
}

function makeRoomCode() {
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  }
  return code;
}

function getDefaultSettings() {
  return { operation: "multiply", targetScore: 10, difficulty: "medium", answerMode: "essay" };
}

function getSettings(room = currentRoom) {
  return { ...getDefaultSettings(), ...(room?.settings || {}) };
}

function maxFactor(difficulty) {
  return difficulty === "easy" ? 10 : difficulty === "hard" ? 100 : 50;
}

function randomFactor(difficulty) {
  return Math.floor(Math.random() * maxFactor(difficulty)) + 1;
}

function makeChoices(correct) {
  const choices = new Set([correct]);
  const spread = Math.max(10, Math.ceil(correct * 0.35));
  while (choices.size < 4) {
    const offset = Math.floor(Math.random() * (spread * 2 + 1)) - spread;
    const candidate = Math.max(0, correct + (offset || 1));
    choices.add(candidate);
  }
  return [...choices].sort(() => Math.random() - 0.5);
}

function getQuestionAnswer(a, b, operation) {
  if (operation === "add") return a + b;
  if (operation === "subtract") return a - b;
  if (operation === "divide") return a / b;
  if (operation === "power") return a ** b;
  if (operation === "root") return Math.sqrt(a);
  if (operation === "solveX") return (b - a) / 1; // Legacy fallback; generated questions store answer directly.
  return a * b;
}

function operationSymbol(operation) {
  return ({ add: "+", subtract: "−", multiply: "×", divide: "÷", power: "^", root: "√", solveX: "x" })[operation] || "×";
}

const QUESTION_TYPES = ["add", "subtract", "multiply", "divide", "power", "root", "solveX"];
const QUESTION_LABELS = {
  add: "PENJUMLAHAN", subtract: "PENGURANGAN", multiply: "PERKALIAN", divide: "PEMBAGIAN",
  power: "PERPANGKATAN / EKSPONEN", root: "AKAR PANGKAT", solveX: "MENCARI NILAI X"
};

function buildQuestionContent(operation, difficulty) {
  const max = maxFactor(difficulty);
  let a = randomFactor(difficulty), b = randomFactor(difficulty), answer, prompt;
  if (operation === "subtract" && b > a) [a, b] = [b, a];
  if (operation === "divide") {
    b = randomFactor(difficulty);
    a = b * randomFactor(difficulty);
  }
  if (operation === "power") {
    a = Math.floor(Math.random() * (difficulty === "easy" ? 4 : difficulty === "hard" ? 9 : 6)) + 2;
    b = Math.floor(Math.random() * 2) + 2;
    answer = a ** b;
    prompt = `${a}<sup>${b}</sup> = ?`;
  } else if (operation === "root") {
    const limit = difficulty === "easy" ? 10 : difficulty === "hard" ? 30 : 20;
    a = Math.floor(Math.random() * limit) + 1;
    answer = a;
    prompt = `√${a * a} = ?`;
  } else if (operation === "solveX") {
    const coefficient = Math.floor(Math.random() * (difficulty === "easy" ? 5 : 10)) + 1;
    const x = randomFactor(difficulty);
    const constant = randomFactor(difficulty);
    const result = coefficient * x + constant;
    answer = x;
    prompt = `${coefficient}x + ${constant} = ${result}; x = ?`;
  } else {
    answer = getQuestionAnswer(a, b, operation);
    prompt = `${a} ${operationSymbol(operation)} ${b} = ?`;
  }
  return { a, b, operation, answer, prompt, instruction: QUESTION_LABELS[operation] || "SOAL CAMPURAN" };
}

function makeQuestion(round, settings = getDefaultSettings()) {
  let operation = settings.operation || "multiply";
  if (operation === "mixed") operation = QUESTION_TYPES[Math.floor(Math.random() * QUESTION_TYPES.length)];
  const content = buildQuestionContent(operation, settings.difficulty || "medium");
  const question = {
    round, ...content,
    startedAt: Date.now(),
    endsAt: Date.now() + ROUND_SECONDS * 1000,
    resolvedRound: round - 1,
    winnerUid: null,
    lastResult: ""
  };
  if (settings.answerMode === "multiple") question.choices = makeChoices(content.answer);
  return question;
}

function roomRef(code = currentRoomCode) {
  return ref(db, `rooms/${code}`);
}

function playerRef(uid, code = currentRoomCode) {
  return ref(db, `rooms/${code}/players/${uid}`);
}

function isHost() {
  return currentRole === "host" && currentUser && currentRoom?.hostUid === currentUser.uid;
}

function stopRoomListener() {
  if (unsubscribeRoom) {
    unsubscribeRoom();
    unsubscribeRoom = null;
  }
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function resetLocalRoom() {
  stopRoomListener();
  stopTimer();
  currentRoomCode = null;
  currentRoom = null;
  currentRole = null;
  processingRound = null;
  hasSubmittedForRound = false;
}

// ---------- AUTH ----------
function usernameToEmail(username) {
  // Firebase Email/Password dipakai sebagai backend, tetapi pengguna cukup memasukkan username.
  return `${username.trim().toLowerCase()}@mathbattle.app`;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  $("authTitle").innerHTML = registering ? 'Buat akun <span>baru.</span>' : 'Selamat datang <span>kembali.</span>';
  $("authDescription").textContent = registering
    ? "Daftar dengan username dan password untuk mulai bermain."
    : "Login untuk masuk ke arena Math Battle.";
  $("authSubmitBtn").innerHTML = registering ? 'Daftar <span>→</span>' : 'Login <span>→</span>';
  $("authSwitchText").textContent = registering ? "Sudah punya akun?" : "Belum punya akun?";
  $("authSwitchBtn").textContent = registering ? "Login sekarang" : "Daftar sekarang";
  $("authPassword").autocomplete = registering ? "new-password" : "current-password";
  $("authError").textContent = "";
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const username = $("authUsername").value.trim();
  const password = $("authPassword").value;
  const normalized = username.toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(normalized)) {
    $("authError").textContent = "Username 3–24 karakter: gunakan huruf, angka, atau underscore.";
    return;
  }
  if (password.length < 6) {
    $("authError").textContent = "Password minimal 6 karakter.";
    return;
  }

  const button = $("authSubmitBtn");
  button.disabled = true;
  button.textContent = authMode === "register" ? "Membuat akun..." : "Memeriksa...";
  $("authError").textContent = "";
  try {
    const email = usernameToEmail(normalized);
    if (authMode === "register") {
      await createUserWithEmailAndPassword(auth, email, password);
      currentName = cleanName(username);
      localStorage.setItem("mathBattleName", currentName);
      toast("Akun berhasil dibuat. Selamat bermain!");
    } else {
      await signInWithEmailAndPassword(auth, email, password);
      currentName = localStorage.getItem("mathBattleName") || cleanName(username);
      toast("Login berhasil!");
    }
    currentUser = auth.currentUser;
    if (!localStorage.getItem("mathBattleName")) localStorage.setItem("mathBattleName", currentName);
    playerNameInput.value = currentName;
    renderProfile();
    updateAccountControls();
    showScreen("homeScreen");
    loadLeaderboard();
  } catch (error) {
    console.error(error);
    const messages = {
      "auth/email-already-in-use": "Username sudah dipakai. Coba login atau gunakan username lain.",
      "auth/invalid-credential": "Username atau password salah.",
      "auth/weak-password": "Password minimal 6 karakter.",
      "auth/network-request-failed": "Koneksi internet bermasalah. Coba lagi."
    };
    $("authError").textContent = messages[error.code] || error.message || "Autentikasi gagal. Coba lagi.";
  } finally {
    button.disabled = false;
    button.innerHTML = authMode === "register" ? 'Daftar <span>→</span>' : 'Login <span>→</span>';
  }
}

async function ensureSignedIn() {
  if (!auth.currentUser) throw new Error("Silakan login terlebih dahulu.");
  currentUser = auth.currentUser;
  return currentUser;
}

// ---------- CREATE ROOM ----------
async function createRoom() {
  if (busy) return;
  currentName = cleanName(playerNameInput.value);
  if (!currentName) return toast("Masukkan nama pemain terlebih dahulu.");
  localStorage.setItem("mathBattleName", currentName);
  renderProfile();

  setBusy(true);
  try {
    await ensureSignedIn();
    await syncProfileName();

    let createdCode = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = makeRoomCode();
      const initialRoom = {
        hostUid: currentUser.uid,
        guestUid: null,
        status: "waiting",
        settings: getDefaultSettings(),
        createdAt: Date.now(),
        matchId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        players: {
          [currentUser.uid]: {
            name: currentName,
            ready: false,
            score: 0
          }
        },
        game: null
      };

      const result = await runTransaction(roomRef(code), current => {
        if (current === null) return initialRoom;
        return; // kode sudah dipakai, batalkan transaksi
      });

      if (result.committed) {
        createdCode = code;
        break;
      }
    }

    if (!createdCode) throw new Error("Tidak berhasil membuat kode room. Coba lagi.");

    currentRoomCode = createdCode;
    currentRole = "host";
    listenToRoom();
    toast("Room berhasil dibuat!");
  } catch (error) {
    console.error(error);
    toast(error.message || "Gagal membuat room. Periksa konfigurasi Firebase.");
  } finally {
    setBusy(false);
  }
}

// ---------- JOIN ROOM ----------
async function joinRoom() {
  if (busy) return;
  currentName = cleanName(playerNameInput.value);
  const code = roomCodeInput.value.trim().toUpperCase();

  if (!currentName) return toast("Masukkan nama pemain terlebih dahulu.");
  if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code)) return toast("Kode room harus terdiri dari 5 karakter.");

  setBusy(true);
  try {
    await ensureSignedIn();
    await syncProfileName();

    const targetRef = roomRef(code);
    const snapshot = await get(targetRef);
    if (!snapshot.exists()) throw new Error("Room tidak ditemukan.");

    const room = snapshot.val();
    if (room.status !== "waiting") throw new Error("Pertandingan di room ini sudah dimulai.");
    if (room.hostUid === currentUser.uid) throw new Error("Kamu tidak bisa bergabung ke room milikmu sendiri.");
    if (room.guestUid && room.guestUid !== currentUser.uid) throw new Error("Room sudah penuh.");

    const joinData = {
      guestUid: currentUser.uid,
      [`players/${currentUser.uid}`]: {
        name: currentName,
        ready: false,
        score: 0
      }
    };

    await update(targetRef, joinData);
    currentRoomCode = code;
    currentRole = "guest";
    listenToRoom();
    toast("Berhasil bergabung ke room!");
  } catch (error) {
    console.error(error);
    toast(error.message || "Gagal bergabung ke room.");
  } finally {
    setBusy(false);
  }
}

// ---------- ROOM LISTENER ----------
function listenToRoom() {
  stopRoomListener();
  showScreen("lobbyScreen");
  $("roomCodeDisplay").textContent = currentRoomCode;
  $("gameRoomCode").textContent = currentRoomCode;

  unsubscribeRoom = onValue(roomRef(), snapshot => {
    if (!snapshot.exists()) {
      toast("Room sudah ditutup.");
      resetLocalRoom();
      showScreen("homeScreen");
      return;
    }

    currentRoom = snapshot.val();
    renderRoom(currentRoom);
    if (currentRoom.status === "finished") checkRematchVotes(currentRoom);

    if (currentRoom.status === "playing") {
      showScreen("gameScreen");
      renderGame(currentRoom);
      if (isHost()) inspectAnswers(currentRoom);
    } else if (currentRoom.status === "finished") {
      stopTimer();
      renderFinished(currentRoom);
      showScreen("finishedScreen");
    } else {
      stopTimer();
      showScreen("lobbyScreen");
    }
  }, error => {
    console.error(error);
    toast("Tidak bisa membaca room. Periksa Firebase Rules.");
  });
}

function renderRoom(room) {
  const host = room.players?.[room.hostUid];
  const guest = room.guestUid ? room.players?.[room.guestUid] : null;

  $("lobbyName1").textContent = host?.name || "Menunggu...";
  $("lobbyName2").textContent = guest?.name || "Menunggu lawan...";
  setReadyPill("lobbyReady1", host?.ready, host ? "NOT READY" : "EMPTY");
  setReadyPill("lobbyReady2", guest?.ready, guest ? "NOT READY" : "EMPTY");

  const me = room.players?.[currentUser.uid];
  const settings = getSettings(room);
  const settingsLocked = !!(host?.ready || guest?.ready);
  operationSelect.value = settings.operation;
  targetScoreSelect.value = String(settings.targetScore);
  difficultySelect.value = settings.difficulty;
  answerModeSelect.value = settings.answerMode;
  [operationSelect, targetScoreSelect, difficultySelect, answerModeSelect].forEach(el => {
    el.disabled = !isHost() || settingsLocked;
  });
  $("settingsOwner").textContent = isHost() ? "HOST SETTINGS" : "DIATUR OLEH HOST";
  $("settingsNote").textContent = settingsLocked
    ? "Pengaturan terkunci setelah pemain menekan tombol siap."
    : isHost()
      ? "Atur tipe soal, target skor, tingkat soal, dan mode jawaban sebelum siap."
      : "Tunggu host mengatur pilihan pertandingan.";
  readyBtn.disabled = !guest || !me;
  readyBtn.textContent = me?.ready ? "Batalkan kesiapan" : "Saya Siap!";
  startBattleBtn.classList.toggle("hidden", !isHost());
  startBattleBtn.disabled = !(host?.ready && guest?.ready);
  $("lobbyMessage").textContent = !guest
    ? "Menunggu pemain kedua bergabung..."
    : (host?.ready && guest?.ready)
      ? "Kedua pemain siap. Host bisa memulai battle!"
      : "Menunggu kedua pemain menekan tombol siap.";
}

function setReadyPill(id, ready, emptyText) {
  const el = $(id);
  el.textContent = ready ? "READY" : emptyText;
  el.classList.toggle("is-ready", !!ready);
}

// ---------- ROOM SETTINGS ----------
async function saveSettings() {
  if (!isHost() || !currentRoom || currentRoom.status !== "waiting") return;
  const host = currentRoom.players?.[currentRoom.hostUid];
  const guest = currentRoom.players?.[currentRoom.guestUid];
  if (host?.ready || guest?.ready) return toast("Batalkan status siap kedua pemain untuk mengubah pengaturan.");
  const settings = {
    operation: operationSelect.value,
    targetScore: Number(targetScoreSelect.value),
    difficulty: difficultySelect.value,
    answerMode: answerModeSelect.value
  };
  try {
    await update(roomRef(), { settings });
  } catch (error) {
    console.error(error);
    toast("Pengaturan gagal disimpan.");
  }
}

// ---------- READY / START ----------
async function toggleReady() {
  if (!currentRoom || !currentRoom.players?.[currentUser.uid]) return;
  const currentReady = !!currentRoom.players[currentUser.uid].ready;
  try {
    await update(playerRef(currentUser.uid), { ready: !currentReady });
  } catch (error) {
    console.error(error);
    toast("Gagal mengubah status siap.");
  }
}

async function startBattle() {
  if (!isHost() || !currentRoom) return;
  const host = currentRoom.players?.[currentRoom.hostUid];
  const guest = currentRoom.players?.[currentRoom.guestUid];

  if (!host?.ready || !guest?.ready) return toast("Kedua pemain harus siap terlebih dahulu.");

  try {
    await update(roomRef(), {
      status: "playing",
      matchId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      game: makeQuestion(1, getSettings(currentRoom)),
      answers: null,
      rematchVotes: null,
      winnerUid: null
    });
  } catch (error) {
    console.error(error);
    toast("Gagal memulai pertandingan.");
  }
}

// ---------- SOUND & FEEDBACK ----------
function unlockAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioContext ||= new AudioCtx();
    if (audioContext.state === "suspended") audioContext.resume();
  } catch (error) {
    console.warn("Audio tidak tersedia:", error);
  }
}

function playTone(frequency = 660, duration = 0.12, type = "sine") {
  if (!soundEnabled) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioContext ||= new AudioCtx();
    if (audioContext.state === "suspended") audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration + 0.02);
  } catch (error) {
    console.warn("Audio tidak tersedia:", error);
  }
}

function playCorrectSound() {
  playTone(740, 0.12);
  setTimeout(() => playTone(990, 0.16), 100);
}

function playWrongSound() {
  playTone(190, 0.2, "triangle");
}

function playCountdownSound() {
  playTone(520, 0.07, "square");
}

function animateAnswer(correct) {
  const panel = $("answerFeedback");
  panel.classList.remove("feedback-correct", "feedback-wrong");
  void panel.offsetWidth;
  panel.classList.add(correct ? "feedback-correct" : "feedback-wrong");
}

// ---------- GAME DISPLAY ----------
function renderGame(room) {
  const players = room.players || {};
  const host = players[room.hostUid];
  const guest = room.guestUid ? players[room.guestUid] : null;
  const game = room.game;

  $("gameName1").textContent = host?.name || "PLAYER 1";
  $("gameName2").textContent = guest?.name || "PLAYER 2";
  $("gameScore1").textContent = host?.score ?? 0;
  $("gameScore2").textContent = guest?.score ?? 0;
  $("roundNumber").textContent = game?.round ?? 1;
  $("gameRoomCode").textContent = currentRoomCode;
  $("roundNumber").parentElement.innerHTML = `ROUND <strong id="roundNumber">${game?.round ?? 1}</strong>`;

  if (!game) return;

  $("questionText").innerHTML = game.prompt || `${game.a} ${operationSymbol(game.operation)} ${game.b}`;
  const settings = getSettings(room);
  $("questionInstruction").textContent = `SELESAIKAN ${game.instruction || QUESTION_LABELS[game.operation] || "SOAL INI"}`;
  $("questionRange").textContent = `${settings.difficulty === "easy" ? "MUDAH" : settings.difficulty === "hard" ? "SULIT" : "MENENGAH"} · TARGET ${settings.targetScore} POIN`;
  const myAnswer = room.answers?.[game.round]?.[currentUser.uid];
  hasSubmittedForRound = !!myAnswer;

  const canAnswer = room.status === "playing" && Date.now() < game.endsAt && !game.winnerUid;
  const multipleMode = settings.answerMode === "multiple";
  const answerLocked = multipleMode && !!myAnswer;
  essayControls.classList.toggle("hidden", multipleMode);
  choiceGrid.classList.toggle("hidden", !multipleMode);
  answerInput.disabled = !canAnswer;
  submitAnswerBtn.disabled = !canAnswer;
  if (!canAnswer) answerInput.value = "";

  if (multipleMode) {
    choiceGrid.innerHTML = "";
    (game.choices || makeChoices(Number(game.answer ?? getQuestionAnswer(game.a, game.b, game.operation || "multiply")))).forEach(value => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice-button";
      button.textContent = value;
      button.disabled = !canAnswer || answerLocked;
      if (myAnswer && Number(myAnswer.value) === Number(value)) button.classList.add("choice-selected");
      button.addEventListener("click", () => submitAnswer(value));
      choiceGrid.appendChild(button);
    });
  }

  if (game.winnerUid) {
    const winnerName = players[game.winnerUid]?.name || "Pemain";
    $("gameMessage").textContent = `${winnerName} mendapatkan poin pada ronde ini!`;
    $("answerFeedback").textContent = "Menyiapkan soal berikutnya...";
    const winnerCard = game.winnerUid === room.hostUid ? document.querySelector(".score-blue") : document.querySelector(".score-pink");
    winnerCard?.classList.add("player-correct");
  } else if (game.lastResult === "timeout") {
    $("gameMessage").textContent = "Waktu habis! Tidak ada poin untuk ronde ini.";
  } else {
    document.querySelectorAll(".score-card").forEach(card => card.classList.remove("player-correct"));
    const opponentUid = currentUser.uid === room.hostUid ? room.guestUid : room.hostUid;
    const opponentAnswered = !!room.answers?.[game.round]?.[opponentUid];
    if (opponentAnswered && !myAnswer) {
      $("gameMessage").textContent = "⚡ Lawan sudah menjawab lebih dulu! Segera kirim jawabanmu.";
      $("gameMessage").classList.add("opponent-first");
    } else {
      $("gameMessage").textContent = myAnswer && multipleMode
        ? "Jawaban sudah dikunci untuk soal ini."
        : "Siapa yang paling cepat menjawab?";
      $("gameMessage").classList.remove("opponent-first");
    }
    if (!myAnswer) $("answerFeedback").textContent = "Masukkan jawaban secepat mungkin.";
  }

  startVisualTimer(game.endsAt);

  if (isHost()) {
    $("gameReady1").textContent = "● HOST";
    $("gameReady2").textContent = "● PLAYER";
  }
}

function startVisualTimer(endsAt) {
  stopTimer();
  const thisRound = currentRoom?.game?.round;
  if (lastRenderedRound !== thisRound) {
    lastRenderedRound = thisRound;
    lastCountdownSecond = null;
    document.querySelectorAll(".score-card").forEach(card => card.classList.remove("player-correct"));
  }
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    $("timerText").textContent = remaining;
    $("timerFill").style.width = `${Math.max(0, (remaining / ROUND_SECONDS) * 100)}%`;
    if (remaining >= 1 && remaining <= ROUND_SECONDS && remaining !== lastCountdownSecond) {
      lastCountdownSecond = remaining;
      playCountdownSound();
      $("timerText").classList.remove("timer-pulse");
      void $("timerText").offsetWidth;
      $("timerText").classList.add("timer-pulse");
    }
    $("timerFill").style.background = remaining <= 5 ? "var(--pink)" : "var(--green)";

    if (remaining <= 0) {
      answerInput.disabled = true;
      submitAnswerBtn.disabled = true;
      if (isHost() && currentRoom?.game && !currentRoom.game.winnerUid) {
        resolveRound(null, "timeout");
      }
      stopTimer();
    }
  };
  tick();
  timerInterval = setInterval(tick, 200);
}

// ---------- SUBMIT ANSWER ----------
async function submitAnswer(selectedValue = null) {
  if (!currentRoom || currentRoom.status !== "playing") return;
  const game = currentRoom.game;
  if (!game || Date.now() >= game.endsAt || game.winnerUid) return;

  const raw = selectedValue === null ? answerInput.value.trim() : String(selectedValue);
  if (!raw) return toast("Isi jawaban terlebih dahulu.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return toast("Masukkan angka yang valid.");

  const correct = value === Number(game.answer ?? getQuestionAnswer(game.a, game.b, game.operation || "multiply"));
  animateAnswer(correct);
  if (correct) {
    playCorrectSound();
    $("answerFeedback").textContent = "Jawaban benar! Menunggu konfirmasi poin...";
  } else {
    playWrongSound();
    $("answerFeedback").textContent = "Belum tepat, coba hitung lagi!";
  }

  try {
    const answerRef = ref(db, `rooms/${currentRoomCode}/answers/${game.round}/${currentUser.uid}`);
    const answerData = { value, submittedAt: Date.now(), mode: getSettings().answerMode, correct };
    if (getSettings().answerMode === "multiple") {
      const result = await runTransaction(answerRef, existing => existing === null ? answerData : undefined);
      if (!result.committed) return toast("Pilihanmu sudah terkunci untuk soal ini.");
    } else {
      await set(answerRef, answerData);
      if (!correct) answerInput.select();
    }
  } catch (error) {
    console.error(error);
    toast("Jawaban gagal dikirim. Periksa koneksi internet.");
  }
}

// ---------- HOST CHECKS ANSWERS ----------
function inspectAnswers(room) {
  const game = room.game;
  if (!game || room.status !== "playing" || game.winnerUid) return;
  if (game.resolvedRound >= game.round) return;
  if (processingRound === game.round) return;

  const roundAnswers = room.answers?.[game.round];
  if (!roundAnswers) return;

  const correctValue = Number(game.answer ?? getQuestionAnswer(game.a, game.b, game.operation || "multiply"));
  const correctEntries = Object.entries(roundAnswers)
    .filter(([uid, answer]) => uid !== undefined && Number(answer?.value) === correctValue)
    .sort((a, b) => (a[1].submittedAt || 0) - (b[1].submittedAt || 0));

  if (correctEntries.length > 0) {
    processingRound = game.round;
    resolveRound(correctEntries[0][0], "correct");
  }
}

async function resolveRound(winnerUid, reason) {
  if (!isHost() || !currentRoom?.game) return;
  const game = currentRoom.game;
  if (game.winnerUid || game.resolvedRound >= game.round) return;
  if (processingRound === game.round && reason === "timeout") return;
  processingRound = game.round;

  try {
    const updates = {
      [`game/resolvedRound`]: game.round,
      [`game/winnerUid`]: winnerUid || null,
      [`game/lastResult`]: reason
    };
    let reachedTarget = false;
    if (winnerUid && currentRoom.players?.[winnerUid]) {
      const newScore = Number(currentRoom.players[winnerUid].score || 0) + 1;
      updates[`players/${winnerUid}/score`] = newScore;
      reachedTarget = newScore >= Number(getSettings(currentRoom).targetScore || 10);
    }
    if (reachedTarget) {
      updates.status = "finished";
      updates.winnerUid = winnerUid;
      updates.finishedAt = Date.now();
      updates.finishReason = "target-score";
    }
    await update(roomRef(), updates);

    if (!reachedTarget) {
      setTimeout(async () => {
        if (!isHost() || !currentRoom || currentRoom.status !== "playing") return;
        const fresh = await get(roomRef());
        if (!fresh.exists()) return;
        const latest = fresh.val();
        const latestGame = latest.game;
        if (!latestGame || latestGame.round !== game.round || latestGame.resolvedRound !== game.round) return;
        await update(roomRef(), {
          game: makeQuestion(game.round + 1, getSettings(latest)),
          [`answers/${game.round + 1}`]: null
        });
        processingRound = null;
      }, winnerUid ? 1450 : 350);
    }
  } catch (error) {
    console.error(error);
    processingRound = null;
    toast("Gagal memperbarui ronde.");
  }
}

// ---------- FINISH ----------
function renderFinished(room) {
  const host = room.players?.[room.hostUid];
  const guest = room.players?.[room.guestUid];
  const scoreHost = Number(host?.score || 0);
  const scoreGuest = Number(guest?.score || 0);
  const winnerUid = room.winnerUid || (scoreHost > scoreGuest ? room.hostUid : scoreGuest > scoreHost ? room.guestUid : null);
  const matchId = room.matchId || `${currentRoomCode}-${room.finishedAt || room.createdAt}`;

  $("finalName1").textContent = host?.name || "PLAYER 1";
  $("finalName2").textContent = guest?.name || "PLAYER 2";
  $("finalScore1").textContent = scoreHost;
  $("finalScore2").textContent = scoreGuest;
  if (winnerUid) {
    const winner = room.players?.[winnerUid];
    const won = winnerUid === currentUser?.uid;
    $("finishedScreen").classList.toggle("result-win", won);
    $("finishedScreen").classList.toggle("result-loss", !won);
    $("winnerTitle").textContent = `${winner?.name || "PEMAIN"} MENANG!`;
    $("finalSummary").textContent = won ? "Selamat! Kamu mencapai target skor lebih dulu." : "Pertandingan selesai. Coba kalahkan lawanmu di rematch!";
    if (lastFinishedMatchId !== matchId) {
      if (won) { playTone(784, .18); setTimeout(() => playTone(988, .2), 150); setTimeout(() => playTone(1175, .25), 310); }
      else { playTone(260, .25, "triangle"); setTimeout(() => playTone(196, .35, "triangle"), 220); }
    }
  } else {
    $("finishedScreen").classList.remove("result-win", "result-loss");
    $("winnerTitle").textContent = "HASIL SERI!";
    $("finalSummary").textContent = "Pertandingan berakhir tanpa pemenang.";
  }
  lastFinishedMatchId = matchId;
  recordMatchStats(room, matchId).catch(error => console.warn("Statistik gagal disimpan:", error));
  rematchBtn.textContent = room.rematchVotes?.[currentUser.uid] ? "Menunggu lawan..." : "Rematch";
  rematchBtn.disabled = !!room.rematchVotes?.[currentUser.uid];
}

async function recordMatchStats(room, matchId) {
  if (!currentUser || !room.players?.[currentUser.uid]) return;
  const uid = currentUser.uid;
  const me = room.players[uid];
  const opponentUid = uid === room.hostUid ? room.guestUid : room.hostUid;
  const won = room.winnerUid === uid;
  const answers = room.answers || {};
  let totalAnswers = 0;
  let correctAnswers = 0;
  for (const roundAnswers of Object.values(answers)) {
    const answer = roundAnswers?.[uid];
    if (!answer) continue;
    totalAnswers++;
    const gameAnswer = answer.value;
    // Correctness is determined against the archived question when available; score remains the match outcome metric.
    if (answer.correct === true) correctAnswers++;
  }
  const profileRef = ref(db, `profiles/${uid}`);
  await runTransaction(profileRef, current => {
    const profile = current || { name: me.name, matches: 0, wins: 0, losses: 0, draws: 0, totalAnswers: 0, correctAnswers: 0 };
    if (profile.lastMatchId === matchId) return profile;
    const next = { ...profile,
      name: me.name,
      matches: Number(profile.matches || 0) + 1,
      wins: Number(profile.wins || 0) + (won ? 1 : 0),
      losses: Number(profile.losses || 0) + (!won && room.winnerUid ? 1 : 0),
      draws: Number(profile.draws || 0) + (!room.winnerUid ? 1 : 0),
      totalAnswers: Number(profile.totalAnswers || 0) + totalAnswers,
      correctAnswers: Number(profile.correctAnswers || 0) + correctAnswers,
      lastMatchId: matchId,
      updatedAt: Date.now()
    };
    next.accuracy = next.totalAnswers ? Math.round(next.correctAnswers / next.totalAnswers * 100) : 0;
    return next;
  });
}

async function voteRematch() {
  if (!currentRoomCode || !currentUser || currentRoom?.status !== "finished") return;
  try {
    await set(ref(db, `rooms/${currentRoomCode}/rematchVotes/${currentUser.uid}`), true);
    toast("Permintaan rematch dikirim. Menunggu lawan...");
  } catch (error) {
    console.error(error);
    toast("Gagal mengirim permintaan rematch.");
  }
}

async function checkRematchVotes(room) {
  if (!isHost() || rematchResetting || room.status !== "finished") return;
  if (!room.guestUid || !room.rematchVotes?.[room.hostUid] || !room.rematchVotes?.[room.guestUid]) return;
  rematchResetting = true;
  try {
    const resetPlayers = {};
    for (const [uid, player] of Object.entries(room.players || {})) resetPlayers[uid] = { ...player, score: 0, ready: false };
    await update(roomRef(), {
      status: "waiting", players: resetPlayers, game: null, answers: null,
      winnerUid: null, finishedAt: null, finishReason: null, rematchVotes: null,
      matchId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    });
    toast("Rematch siap! Silakan tekan tombol siap.");
  } catch (error) {
    console.error(error);
    toast("Gagal memulai rematch.");
  } finally { rematchResetting = false; }
}

// ---------- LEAVE / CLEANUP ----------
async function leaveRoom() {
  if (!currentRoomCode || !currentUser) {
    resetLocalRoom();
    showScreen("homeScreen");
    return;
  }

  const code = currentRoomCode;
  const host = currentRole === "host";
  stopRoomListener();
  stopTimer();

  try {
    if (host) {
      await remove(ref(db, `rooms/${code}`));
    } else {
      await update(ref(db, `rooms/${code}`), {
        guestUid: null,
        [`players/${currentUser.uid}`]: null
      });
    }
  } catch (error) {
    console.error(error);
    toast("Tidak bisa membersihkan room, tetapi kamu keluar dari halaman.");
  }

  resetLocalRoom();
  showScreen("homeScreen");
}

async function copyRoomCode() {
  if (!currentRoomCode) return;
  try {
    await navigator.clipboard.writeText(currentRoomCode);
    $("copyFeedback").textContent = "KODE BERHASIL DISALIN!";
  } catch {
    $("copyFeedback").textContent = `KODE ROOM: ${currentRoomCode}`;
  }
}

// ---------- PROFILE, GLOBAL LEADERBOARD & PRACTICE ----------
function renderProfile(profile = {}) {
  $("profileName").textContent = profile.name || currentName || "Pemain";
  const matches = Number(profile.matches || 0);
  const wins = Number(profile.wins || 0);
  const accuracy = Number(profile.accuracy || 0);
  const losses = Number(profile.losses || 0);
  $("profileStats").textContent = `${matches} pertandingan · ${wins} menang · ${losses} kalah · Akurasi ${accuracy}%`;
}

function loadLeaderboard(forceRefresh = false) {
  if (!currentUser) return;
  if (leaderboardUnsubscribe && !forceRefresh) return;
  if (leaderboardUnsubscribe) leaderboardUnsubscribe();
  leaderboardUnsubscribe = onValue(ref(db, "profiles"), snapshot => {
    const profiles = snapshot.exists() ? Object.entries(snapshot.val()) : [];
    profiles.sort((a, b) => Number(b[1].wins || 0) - Number(a[1].wins || 0)
      || Number(b[1].accuracy || 0) - Number(a[1].accuracy || 0)
      || Number(b[1].matches || 0) - Number(a[1].matches || 0));
    const list = $("leaderboardList");
    list.innerHTML = "";
    if (!profiles.length) { list.innerHTML = "<li>Belum ada data pemain.</li>"; renderProfile(); return; }
    profiles.slice(0, 10).forEach(([uid, profile], index) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      const stats = document.createElement("strong");
      name.textContent = `${index + 1}. ${profile.name || "Pemain"}${uid === currentUser.uid ? " (Kamu)" : ""}`;
      stats.textContent = `${Number(profile.wins || 0)}W · ${Number(profile.accuracy || 0)}%`;
      li.append(name, stats); list.appendChild(li);
    });
    const own = snapshot.val()?.[currentUser.uid];
    if (own) renderProfile(own); else renderProfile();
  }, error => {
    console.warn(error);
    $("leaderboardList").innerHTML = "<li>Leaderboard belum tersedia. Periksa Firebase Rules.</li>";
  });
}

async function syncProfileName() {
  if (!currentUser || !currentName) return;
  const profileRef = ref(db, `profiles/${currentUser.uid}`);
  await runTransaction(profileRef, profile => ({
    ...(profile || { matches: 0, wins: 0, losses: 0, draws: 0, totalAnswers: 0, correctAnswers: 0, accuracy: 0 }),
    name: currentName,
    updatedAt: Date.now()
  }));
}

function makePracticeQuestion() {
  const difficulty = $("practiceDifficulty").value;
  const operation = $("practiceOperation").value;
  const selectedOperation = operation === "mixed" ? QUESTION_TYPES[Math.floor(Math.random() * QUESTION_TYPES.length)] : operation;
  practiceCurrent = buildQuestionContent(selectedOperation, difficulty);
  $("practiceQuestion").innerHTML = practiceCurrent.prompt;
  $("practiceAnswer").value = "";
  $("practiceFeedback").textContent = "Masukkan jawabanmu.";
  $("practiceAnswer").focus();
}

function checkPracticeAnswer() {
  if (!practiceCurrent) return;
  const raw = $("practiceAnswer").value.trim();
  if (!raw) return toast("Masukkan jawaban terlebih dahulu.");
  if (Number(raw) === practiceCurrent.answer) {
    $("practiceFeedback").textContent = "Benar! Bagus, lanjut ke soal berikutnya.";
    $("practiceFeedback").classList.remove("feedback-wrong");
    $("practiceFeedback").classList.add("feedback-correct");
    playCorrectSound();
  } else {
    $("practiceFeedback").textContent = "Belum tepat. Coba hitung lagi.";
    $("practiceFeedback").classList.remove("feedback-correct");
    $("practiceFeedback").classList.add("feedback-wrong");
    playWrongSound();
  }
}

// ---------- EVENTS ----------
$("logoutBtn").addEventListener("click", handleLogout);
createRoomBtn.addEventListener("click", createRoom);
joinRoomBtn.addEventListener("click", joinRoom);
readyBtn.addEventListener("click", toggleReady);
startBattleBtn.addEventListener("click", startBattle);
[operationSelect, targetScoreSelect, difficultySelect, answerModeSelect].forEach(el => el.addEventListener("change", saveSettings));
rematchBtn.addEventListener("click", voteRematch);
soundToggle.checked = soundEnabled;
soundToggle.addEventListener("change", () => {
  soundEnabled = soundToggle.checked;
  localStorage.setItem("mathBattleSound", soundEnabled ? "on" : "off");
  toast(soundEnabled ? "Suara diaktifkan." : "Suara dimatikan.");
});
practiceOpenBtn.addEventListener("click", () => { showScreen("practiceScreen"); makePracticeQuestion(); });
$("practiceNextBtn").addEventListener("click", makePracticeQuestion);
$("practiceCheckBtn").addEventListener("click", checkPracticeAnswer);
$("practiceBackBtn").addEventListener("click", () => showScreen("homeScreen"));
$("practiceAnswer").addEventListener("keydown", event => { if (event.key === "Enter") checkPracticeAnswer(); });
$("refreshLeaderboardBtn").addEventListener("click", () => loadLeaderboard(true));
document.addEventListener("pointerdown", unlockAudio, { once: true });
leaveRoomBtn.addEventListener("click", leaveRoom);
exitGameBtn.addEventListener("click", leaveRoom);
copyCodeBtn.addEventListener("click", copyRoomCode);
submitAnswerBtn.addEventListener("click", submitAnswer);
answerInput.addEventListener("keydown", event => {
  if (event.key === "Enter") submitAnswer();
});
roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 5);
});
backHomeBtn.addEventListener("click", leaveRoom);

// ---------- BOOT ----------
$("authForm").addEventListener("submit", handleAuthSubmit);
$("authSwitchBtn").addEventListener("click", () => setAuthMode(authMode === "login" ? "register" : "login"));

(async function boot() {
  try {
    // Tunggu Firebase memulihkan sesi tersimpan sebelum menentukan layar awal.
    await new Promise((resolve, reject) => {
      const unsubscribe = onAuthStateChanged(auth, user => {
        unsubscribe();
        currentUser = user;
        resolve();
      }, reject);
    });
    currentName = localStorage.getItem("mathBattleName") || "";
    if (currentName) playerNameInput.value = currentName;
    renderProfile();
    playerNameInput.addEventListener("change", () => {
      currentName = cleanName(playerNameInput.value);
      localStorage.setItem("mathBattleName", currentName);
      renderProfile();
      updateAccountControls();
    });
    showScreen(currentUser ? "homeScreen" : "authScreen");
    updateAccountControls();
    if (currentUser) loadLeaderboard();
  } catch (error) {
    console.error(error);
    $("authError").textContent = "Firebase belum siap. Periksa konfigurasi dan koneksi internet.";
    showScreen("authScreen");
  }
})();
