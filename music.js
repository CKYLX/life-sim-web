// ============================================================
//  背景钢琴纯音乐（Web Audio API 合成，无需外部音频文件）
//  10 首舒缓旋律轮流播放，右上角 🎵 按钮开关
// ============================================================

const PIANO_SONGS = [
  { name: '致爱丽丝', tempo: 72, notes: [[76,1],[75,1],[76,1],[75,1],[76,1],[71,1],[74,1],[72,1],[69,2],[60,1],[64,1],[69,1],[71,2],[64,1],[68,1],[71,2],[72,1],[64,1],[68,1],[72,2],[69,1],[64,1],[68,1],[72,2]] },
  { name: '欢乐颂', tempo: 70, notes: [[64,1],[64,1],[65,1],[67,1],[67,1],[65,1],[64,1],[62,1],[60,1],[60,1],[62,1],[64,1],[64,1.5],[62,0.5],[62,2]] },
  { name: '小星星', tempo: 80, notes: [[60,1],[60,1],[67,1],[67,1],[69,1],[69,1],[67,2],[65,1],[65,1],[64,1],[64,1],[62,1],[62,1],[60,2]] },
  { name: '卡农', tempo: 60, notes: [[64,1],[62,1],[60,1],[62,1],[64,1],[65,1],[67,1],[69,1],[67,1],[65,1],[64,1],[62,1],[60,2],[60,1],[62,1],[64,1],[65,1],[67,1],[69,1],[65,1],[67,2]] },
  { name: '摇篮曲', tempo: 66, notes: [[60,1],[64,1],[67,1],[64,1],[60,1],[64,1],[67,1],[64,1],[62,1],[65,1],[69,1],[65,1],[62,1],[65,1],[69,1],[65,1],[64,2]] },
  { name: '天空之城', tempo: 68, notes: [[69,1],[71,1],[72,1],[71,1],[72,1],[76,1],[74,1],[72,1],[67,1],[69,1],[71,2],[67,1],[71,1],[74,1],[72,1],[71,1],[69,1],[67,2]] },
  { name: '茉莉花', tempo: 72, notes: [[67,1],[69,1],[72,1],[69,1],[67,1],[64,1],[67,1],[69,1],[67,1],[64,1],[62,1],[64,1],[62,1],[60,2]] },
  { name: '平安夜', tempo: 70, notes: [[67,1.5],[69,0.5],[67,2],[64,3],[67,1.5],[69,0.5],[67,2],[64,3],[74,1],[74,1],[71,2],[72,1],[72,1],[67,3]] },
  { name: '绿袖子', tempo: 64, notes: [[69,2],[72,1],[74,1],[76,1.5],[77,0.5],[76,1],[74,1],[71,1],[67,1],[69,1],[71,1],[72,2],[69,2]] },
  { name: '友谊地久天长', tempo: 68, notes: [[67,1],[72,1],[71,1],[72,1],[76,1],[74,1],[72,1],[74,1],[76,1],[72,1],[67,2],[67,1],[72,1],[74,1],[76,1],[74,1],[72,1],[71,2]] },
];

let audioCtx = null;
let masterGain = null;
let musicOn = false;
let musicTimer = null;
let songIndex = 0;

function midiFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.7;
    masterGain.connect(audioCtx.destination);
  }
  return audioCtx;
}

function playPianoNote(ctx, midi, when, dur, vol) {
  // 主音 + 低八度补厚，模拟柔和钢琴
  const layers = [[midi, vol], [midi - 12, vol * 0.35]];
  for (const [m, v] of layers) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiFreq(m);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    osc.connect(g);
    g.connect(masterGain || ctx.destination);
    osc.start(when);
    osc.stop(when + dur + 0.1);
  }
}

function playPianoSong(ctx, song) {
  const beat = 60 / song.tempo;
  let t = ctx.currentTime + 0.15;
  for (const [midi, beats] of song.notes) {
    const dur = Math.max(beats * beat * 1.9, 0.18);
    playPianoNote(ctx, midi, t, dur, 0.14);
    t += beats * beat;
  }
  return Math.max((t - ctx.currentTime) * 1000 + 600, 800);
}

function scheduleNextSong() {
  if (!musicOn || !audioCtx) return;
  const song = PIANO_SONGS[songIndex % PIANO_SONGS.length];
  const durMs = playPianoSong(audioCtx, song);
  songIndex++;
  musicTimer = setTimeout(scheduleNextSong, durMs);
}

function toggleMusic() {
  const btn = document.getElementById('musicBtn');
  musicOn = !musicOn;
  if (musicOn) {
    const ctx = ensureAudio();
    if (!ctx) { musicOn = false; return; }
    if (ctx.state === 'suspended') ctx.resume();
    if (masterGain) {
      masterGain.gain.cancelScheduledValues(ctx.currentTime);
      masterGain.gain.setValueAtTime(0.7, ctx.currentTime);
    }
    if (btn) btn.classList.remove('off');
    clearTimeout(musicTimer);
    scheduleNextSong();
  } else {
    if (btn) btn.classList.add('off');
    clearTimeout(musicTimer);
    if (audioCtx && masterGain) {
      masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
      masterGain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    }
  }
}
