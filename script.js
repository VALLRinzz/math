import { auth, db } from "./firebase-config.js";
import { signInAnonymously } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  ref, get, set, update, remove, onValue, runTransaction
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

// ---------- ELEMENTS ----------
const $ = (id) => document.getElementById(id);
const screens = ["homeScreen", "lobbyScreen", "gameScreen", "finishedScreen"];

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
const roundsSelect = $("roundsSelect");
const difficultySelect = $("difficultySelect");
const answerModeSelect = $("answerModeSelect");
const choiceGrid = $("choiceGrid");
const essayControls = $("essayControls");
const backHomeBtn = $("backHomeBtn");
const exitGameBtn = $("exitGameBtn");

const ROUND_SECONDS = 20;
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let currentUser = null;
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
  return { totalRounds: 10, difficulty: "medium", answerMode: "essay" };
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

function makeQuestion(round, settings = getDefaultSettings()) {
  const a = randomFactor(settings.difficulty);
  const b = randomFactor(settings.difficulty);
  const question = {
    round, a, b,
    startedAt: Date.now(),
    endsAt: Date.now() + ROUND_SECONDS * 1000,
    resolvedRound: round - 1,
    winnerUid: null,
    lastResult: ""
  };
  if (settings.answerMode === "multiple") question.choices = makeChoices(a * b);
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
async function ensureSignedIn() {
  if (auth.currentUser) {
    currentUser = auth.currentUser;
    return currentUser;
  }
  const credential = await signInAnonymously(auth);
  currentUser = credential.user;
  return currentUser;
}

// ---------- CREATE ROOM ----------
async function createRoom() {
  if (busy) return;
  currentName = cleanName(playerNameInput.value);
  if (!currentName) return toast("Masukkan nama pemain terlebih dahulu.");

  setBusy(true);
  try {
    await ensureSignedIn();

    let createdCode = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = makeRoomCode();
      const initialRoom = {
        hostUid: currentUser.uid,
        guestUid: null,
        status: "waiting",
        settings: getDefaultSettings(),
        createdAt: Date.now(),
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
  roundsSelect.value = String(settings.totalRounds);
  difficultySelect.value = settings.difficulty;
  answerModeSelect.value = settings.answerMode;
  [roundsSelect, difficultySelect, answerModeSelect].forEach(el => {
    el.disabled = !isHost() || settingsLocked;
  });
  $("settingsOwner").textContent = isHost() ? "HOST SETTINGS" : "DIATUR OLEH HOST";
  $("settingsNote").textContent = settingsLocked
    ? "Pengaturan terkunci setelah pemain menekan tombol siap."
    : isHost()
      ? "Atur ronde, tingkat soal, dan mode jawaban sebelum siap."
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
    totalRounds: Number(roundsSelect.value),
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
      game: makeQuestion(1, getSettings(currentRoom)),
      answers: null
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
  const totalRounds = getSettings(room).totalRounds;
  $("roundNumber").parentElement.innerHTML = `ROUND <strong id="roundNumber">${game?.round ?? 1}</strong> / ${totalRounds}`;

  if (!game) return;

  $("questionText").textContent = `${game.a} × ${game.b}`;
  const settings = getSettings(room);
  $("questionRange").textContent = `${settings.difficulty === "easy" ? "MUDAH" : settings.difficulty === "hard" ? "SULIT" : "MENENGAH"} · 1–${maxFactor(settings.difficulty)}`;
  const myAnswer = room.answers?.[game.round]?.[currentUser.uid];
  hasSubmittedForRound = !!myAnswer;

  const canAnswer = room.status === "playing" && Date.now() < game.endsAt && !game.winnerUid;
  const multipleMode = settings.answerMode === "multiple";
  essayControls.classList.toggle("hidden", multipleMode);
  choiceGrid.classList.toggle("hidden", !multipleMode);
  answerInput.disabled = !canAnswer;
  submitAnswerBtn.disabled = !canAnswer;
  if (!canAnswer) answerInput.value = "";

  if (multipleMode) {
    choiceGrid.innerHTML = "";
    (game.choices || makeChoices(game.a * game.b)).forEach(value => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice-button";
      button.textContent = value;
      button.disabled = !canAnswer;
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
    $("gameMessage").textContent = "Siapa yang paling cepat menjawab?";
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
    if (remaining >= 1 && remaining <= 5 && remaining !== lastCountdownSecond) {
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

  const correct = value === game.a * game.b;
  animateAnswer(correct);
  if (correct) {
    playCorrectSound();
    $("answerFeedback").textContent = "Jawaban benar! Menunggu konfirmasi poin...";
  } else {
    playWrongSound();
    $("answerFeedback").textContent = "Belum tepat, coba hitung lagi!";
  }

  try {
    await set(ref(db, `rooms/${currentRoomCode}/answers/${game.round}/${currentUser.uid}`), {
      value,
      submittedAt: Date.now()
    });
    if (!correct && selectedValue === null) answerInput.select();
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

  const correctValue = game.a * game.b;
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

    if (winnerUid && currentRoom.players?.[winnerUid]) {
      const oldScore = Number(currentRoom.players[winnerUid].score || 0);
      updates[`players/${winnerUid}/score`] = oldScore + 1;
    }

    await update(roomRef(), updates);

    setTimeout(async () => {
      if (!isHost() || !currentRoom || currentRoom.status !== "playing") return;
      const fresh = await get(roomRef());
      if (!fresh.exists()) return;
      const latest = fresh.val();
      const latestGame = latest.game;
      if (!latestGame || latestGame.round !== game.round || latestGame.resolvedRound !== game.round) return;

      const hostScore = Number(latest.players?.[latest.hostUid]?.score || 0);
      const guestScore = Number(latest.players?.[latest.guestUid]?.score || 0);

      const totalRounds = Number(latest.settings?.totalRounds || 10);
      if (game.round >= totalRounds) {
        await update(roomRef(), { status: "finished" });
      } else {
        await update(roomRef(), {
          game: makeQuestion(game.round + 1, getSettings(latest)),
          [`answers/${game.round + 1}`]: null
        });
      }
      processingRound = null;
    }, 1450);
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

  $("finalName1").textContent = host?.name || "PLAYER 1";
  $("finalName2").textContent = guest?.name || "PLAYER 2";
  $("finalScore1").textContent = scoreHost;
  $("finalScore2").textContent = scoreGuest;

  if (scoreHost > scoreGuest) {
    $("winnerTitle").textContent = `${host.name} MENANG!`;
    $("finalSummary").textContent = "Permainan hebat! Player 1 memenangkan Math Battle.";
  } else if (scoreGuest > scoreHost) {
    $("winnerTitle").textContent = `${guest.name} MENANG!`;
    $("finalSummary").textContent = "Permainan hebat! Player 2 memenangkan Math Battle.";
  } else {
    $("winnerTitle").textContent = "HASIL SERI!";
    $("finalSummary").textContent = "Skor sama kuat. Kalian bermain dengan seimbang!";
  }
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

// ---------- EVENTS ----------
createRoomBtn.addEventListener("click", createRoom);
joinRoomBtn.addEventListener("click", joinRoom);
readyBtn.addEventListener("click", toggleReady);
startBattleBtn.addEventListener("click", startBattle);
[roundsSelect, difficultySelect, answerModeSelect].forEach(el => el.addEventListener("change", saveSettings));
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
(async function boot() {
  try {
    await ensureSignedIn();
    showScreen("homeScreen");
  } catch (error) {
    console.error(error);
    toast("Firebase Authentication belum siap. Periksa pengaturan Firebase.");
  }
})();
