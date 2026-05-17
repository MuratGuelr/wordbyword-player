import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { getDatabase, ref, set, onValue, update, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyARreH7yBFdaeYwMQftLjUfRvSy9KnijBA",
  authDomain: "transcript-manager-61e39.firebaseapp.com",
  projectId: "transcript-manager-61e39",
  storageBucket: "transcript-manager-61e39.firebasestorage.app",
  messagingSenderId: "865889949005",
  appId: "1:865889949005:web:c4c559b0f19569fce6d304"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// State
let currentUser = null;
let isHost = false; // true if audio is loaded locally
let cues = [];
let mode = 'sentence'; // 'sentence' | 'word'
let curI = -1;
let sentencesCache = [];
let audioFileLoaded = false;
let lastTriggerJump = null;
let lastTriggerToggle = null;
let remoteIsPlaying = false; // Used to track play state on remote

// DOM Elements
const authSection = document.getElementById('auth-section');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const userProfile = document.getElementById('user-profile');
const userName = document.getElementById('user-name');
const userAvatar = document.getElementById('user-avatar');

const drawer = document.getElementById('upload-drawer');
const toggleDrawerBtn = document.getElementById('toggle-drawer-btn');
const emptyState = document.getElementById('empty-state');
const cuelist = document.getElementById('cuelist');
const syncStatus = document.getElementById('sync-status');
const roleBadge = document.getElementById('role-badge');
const playingFilename = document.getElementById('playing-filename');

const audio = document.getElementById('audio-player');
const progressFill = document.getElementById('progress-fill');
const progressThumb = document.getElementById('progress-thumb');
const progressBar = document.getElementById('progress-bar');
const timeCurrent = document.getElementById('time-current');
const timeDuration = document.getElementById('time-duration');
const btnPlayPause = document.getElementById('btn-play-pause');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');

// Firebase Auth
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) {
    loginBtn.classList.add('hidden');
    userProfile.classList.remove('hidden');
    userName.textContent = user.displayName.split(' ')[0];
    userAvatar.src = user.photoURL;
    syncStatus.innerHTML = '<div class="pulse-dot"></div> Connected to Sync';
    listenToSession();
  } else {
    loginBtn.classList.remove('hidden');
    userProfile.classList.add('hidden');
    syncStatus.innerHTML = 'Please log in to sync';
    cues = [];
    buildList();
  }
});

loginBtn.addEventListener('click', () => {
  const provider = new GoogleAuthProvider();
  signInWithPopup(auth, provider).catch(err => console.error("Login failed", err));
});

logoutBtn.addEventListener('click', () => {
  signOut(auth);
});

// Drawer toggle
toggleDrawerBtn.addEventListener('click', () => {
  drawer.classList.toggle('collapsed');
  toggleDrawerBtn.style.transform = drawer.classList.contains('collapsed') ? 'rotate(180deg)' : 'rotate(0deg)';
});

// Mode toggles
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    mode = e.target.dataset.mode;
    buildList();
    if (currentUser) {
      update(ref(db, `users/${currentUser.uid}/session/state`), { mode });
    }
  });
});

// Drag & Drop
const dzAudio = document.getElementById('dz-audio');
const dzText = document.getElementById('dz-text');

[dzAudio, dzText].forEach(dz => {
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (dz.id === 'dz-audio') handleAudio(file);
    else handleText(file);
  });
});

document.getElementById('file-audio').addEventListener('change', e => {
  if (e.target.files[0]) handleAudio(e.target.files[0]);
});
document.getElementById('file-text').addEventListener('change', e => {
  if (e.target.files[0]) handleText(e.target.files[0]);
});

function handleAudio(f) {
  audio.src = URL.createObjectURL(f);
  audio.load();
  audioFileLoaded = true;
  setHostMode(true);
  dzAudio.classList.add('loaded');
  dzAudio.querySelector('p').innerHTML = `<strong>${f.name}</strong><br>Ready to play`;
  playingFilename.textContent = f.name;
  
  if (currentUser) {
    update(ref(db, `users/${currentUser.uid}/session/state`), { fileName: f.name });
  }
}

function handleText(f) {
  const r = new FileReader();
  r.onload = (e) => {
    parseTranscript(e.target.result);
    dzText.classList.add('loaded');
    dzText.querySelector('p').innerHTML = `<strong>${f.name}</strong><br>${cues.length} segments`;
    
    if (currentUser) {
      set(ref(db, `users/${currentUser.uid}/session/cues`), JSON.stringify(cues));
    }
  };
  r.readAsText(f);
}

function setHostMode(isH) {
  isHost = isH;
  roleBadge.textContent = isHost ? 'Host' : 'Remote';
  roleBadge.className = 'sync-badge ' + (isHost ? 'host' : '');
  if (!isHost) {
    drawer.classList.add('collapsed');
  } else {
    drawer.classList.remove('collapsed');
  }
}

// Parse logic
function parseTranscript(raw) {
  raw = raw.trim();
  let parsed = false;
  if (raw[0] === '[' || raw[0] === '{') {
    try {
      const d = JSON.parse(raw);
      const a = Array.isArray(d) ? d : [d];
      if ("stop" in a[0] || "end" in a[0]) {
        cues = a.filter((o) => o && o.text).map((o) => ({
          start: +o.start,
          end: +(o.stop ?? o.end),
          text: o.text.trim(),
        }));
        parsed = true;
      }
    } catch (e) {}
  }
  if (!parsed) parseSRT(raw);
  buildList();
}

function parseSRT(raw) {
  cues = [];
  const vtt = raw.startsWith("WEBVTT");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let i = vtt ? 1 : 0;
  while (i < lines.length) {
    if (/^\d+$/.test((lines[i] || "").trim())) i++;
    const tc = lines[i] || "";
    if (!tc.includes("-->")) { i++; continue; }
    const [a, b] = tc.split("-->");
    const s = tc2s(a.trim()), e = tc2s(b.trim().split(" ")[0]);
    i++;
    const tl = [];
    while (i < lines.length && lines[i].trim()) { tl.push(lines[i].replace(/<[^>]*>/g, "")); i++; }
    while (i < lines.length && !lines[i].trim()) i++;
    if (tl.length && !isNaN(s)) cues.push({ start: s, end: e, text: tl.join(" ").trim() });
  }
}

function tc2s(tc) {
  tc = tc.replace(",", ".");
  const p = tc.split(":");
  if (p.length === 3) return +p[0] * 3600 + +p[1] * 60 + +p[2];
  if (p.length === 2) return +p[0] * 60 + +p[1];
  return +tc;
}

// Build UI
function buildList() {
  cuelist.innerHTML = '';
  if (!cues || cues.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  if (mode === 'sentence') {
    sentencesCache = mergeSentences(cues);
    sentencesCache.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'seg';
      el.dataset.i = i;
      el.innerHTML = `<div class="seg-time">${ft(s.start)}</div><div class="seg-text">${escapeHTML(s.text)}</div>`;
      el.addEventListener('click', () => {
        if (el.classList.contains('active')) {
          togglePlaySync();
        } else {
          requestJump(s.start);
        }
      });
      cuelist.appendChild(el);
    });
  } else {
    const prose = document.createElement('div');
    prose.className = 'prose';
    let lastTs = -999;
    cues.forEach((c, ci) => {
      const dur = c.end - c.start || 1;
      const words = c.text.trim().split(/\s+/).filter(Boolean);
      if (c.start - lastTs >= 8) {
        const tsSpan = document.createElement("span");
        tsSpan.className = "w-ts";
        tsSpan.textContent = ft(c.start);
        prose.appendChild(tsSpan);
        prose.appendChild(document.createTextNode(" "));
        lastTs = c.start;
      }
      words.forEach((w, wi) => {
        const t = c.start + (wi / words.length) * dur;
        const sp = document.createElement("span");
        sp.className = "w-word";
        sp.dataset.t = t;
        sp.dataset.ci = ci;
        sp.textContent = w;
        sp.addEventListener('click', () => {
          if (sp.classList.contains('active')) {
            togglePlaySync();
          } else {
            requestJump(t);
          }
        });
        prose.appendChild(sp);
        prose.appendChild(document.createTextNode(" "));
      });
    });
    cuelist.appendChild(prose);
  }
}

function mergeSentences(cuesList) {
  const out = [];
  let buf = null;
  cuesList.forEach((c, i) => {
    if (!buf) buf = { start: c.start, end: c.end, text: c.text.trim() };
    else { buf.text += " " + c.text.trim(); buf.end = c.end; }
    if (/[.!?]$/.test(buf.text.trimEnd()) || i === cuesList.length - 1) {
      out.push(buf); buf = null;
    }
  });
  if (buf) out.push(buf);
  return out;
}

// Playback Logic
function requestJump(time) {
  if (isHost) {
    audio.currentTime = time;
    audio.play();
  }
  if (currentUser) {
    update(ref(db, `users/${currentUser.uid}/session/state`), {
      currentTime: time,
      isPlaying: true,
      triggerJump: serverTimestamp()
    });
  }
}

function togglePlaySync() {
  if (isHost) {
    if (audio.paused) audio.play();
    else audio.pause();
  } else {
    // If remote, send request to change isPlaying
    const nextState = !remoteIsPlaying;
    if (currentUser) {
      update(ref(db, `users/${currentUser.uid}/session/state`), {
        isPlaying: nextState,
        triggerPlayToggle: serverTimestamp()
      });
    }
  }
}

btnPlayPause.addEventListener('click', togglePlaySync);

document.getElementById('btn-skip-back').addEventListener('click', () => requestJump(Math.max(0, audio.currentTime - 5)));
document.getElementById('btn-skip-fwd').addEventListener('click', () => requestJump(Math.min(audio.duration || 0, audio.currentTime + 5)));

audio.addEventListener('timeupdate', () => {
  if (isHost) {
    updateProgressUI(audio.currentTime, audio.duration);
    syncCurrentSeg(audio.currentTime);
    
    // Periodically update DB so remote stays somewhat in sync visually
    if (currentUser && Math.random() < 0.2) {
      update(ref(db, `users/${currentUser.uid}/session/state`), { currentTime: audio.currentTime });
    }
  }
});

audio.addEventListener('play', () => { 
  iconPlay.classList.add('hidden'); 
  iconPause.classList.remove('hidden');
  remoteIsPlaying = true;
  if (currentUser && isHost) update(ref(db, `users/${currentUser.uid}/session/state`), { isPlaying: true });
});

audio.addEventListener('pause', () => { 
  iconPlay.classList.remove('hidden'); 
  iconPause.classList.add('hidden');
  remoteIsPlaying = false;
  if (currentUser && isHost) update(ref(db, `users/${currentUser.uid}/session/state`), { isPlaying: false });
});

audio.addEventListener('loadedmetadata', () => { timeDuration.textContent = ft(audio.duration); });

progressBar.addEventListener('click', (e) => {
  const r = progressBar.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * (audio.duration || 0);
  requestJump(t);
});

function updateProgressUI(current, duration) {
  if (!duration) return;
  const p = (current / duration) * 100;
  progressFill.style.width = p + "%";
  progressThumb.style.left = p + "%";
  timeCurrent.textContent = ft(current);
}

function syncCurrentSeg(time) {
  if (mode === 'sentence') {
    let si = -1;
    for (let i = 0; i < sentencesCache.length; i++) {
      if (time >= sentencesCache[i].start && time <= sentencesCache[i].end) { si = i; break; }
    }
    if (si !== curI && si !== -1) {
      document.querySelectorAll('.seg').forEach(el => el.classList.remove('active'));
      const el = document.querySelector(`.seg[data-i="${si}"]`);
      if (el) {
        el.classList.add('active');
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      curI = si;
    }
  } else {
    // Word mode logic
    let best = null;
    document.querySelectorAll('.w-word').forEach(w => {
      if (parseFloat(w.dataset.t) <= time) best = w;
    });
    if (best && !best.classList.contains('active')) {
      document.querySelectorAll('.w-word').forEach(w => w.classList.remove('active'));
      best.classList.add('active');
      best.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

// Firebase Sync Listener
function listenToSession() {
  const sessionRef = ref(db, `users/${currentUser.uid}/session`);
  
  onValue(sessionRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const data = snapshot.val();
    
    // Only load cues from DB if we are remote
    if (data.cues && !isHost) {
      const parsedCues = JSON.parse(data.cues);
      if (JSON.stringify(cues) !== data.cues) {
        cues = parsedCues;
        buildList();
      }
    }
    
    if (data.state) {
      const state = data.state;
      
      if (state.fileName && !isHost) {
        playingFilename.textContent = state.fileName;
        setHostMode(false);
      }
      
      if (state.mode && state.mode !== mode) {
        mode = state.mode;
        document.querySelectorAll('.mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === mode);
        });
        buildList();
      }
      
      if (state.isPlaying !== undefined) {
        remoteIsPlaying = state.isPlaying;
        if (!isHost) {
          if (state.isPlaying) {
            iconPlay.classList.add('hidden');
            iconPause.classList.remove('hidden');
          } else {
            iconPlay.classList.remove('hidden');
            iconPause.classList.add('hidden');
          }
        }
      }
      
      // If triggerJump changed, someone requested a jump
      if (state.triggerJump && state.triggerJump !== lastTriggerJump) {
        lastTriggerJump = state.triggerJump;
        if (isHost && audioFileLoaded) {
          audio.currentTime = state.currentTime;
          audio.play().catch(e => console.log("Play prevented", e));
        }
      }
      
      // If triggerPlayToggle changed, toggle play/pause
      if (state.triggerPlayToggle && state.triggerPlayToggle !== lastTriggerToggle) {
        lastTriggerToggle = state.triggerPlayToggle;
        if (isHost && audioFileLoaded) {
          if (state.isPlaying) audio.play();
          else audio.pause();
        }
      }
      
      // If we are remote, just sync UI to current time
      if (!isHost && state.currentTime !== undefined) {
        syncCurrentSeg(state.currentTime);
        timeCurrent.textContent = ft(state.currentTime);
      }
    }
  });
}

// Search
document.getElementById('search-input').addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  document.querySelectorAll('.seg').forEach(el => {
    const txt = el.querySelector('.seg-text').textContent.toLowerCase();
    if (!q || txt.includes(q)) {
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  });
});

// Utils
function ft(s) {
  s = Math.floor(s || 0);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag]));
}
