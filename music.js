// ============================================================
//  背景音乐：用户本地歌单（26 首，转码后存放于 music/ 目录）
//  右上角 🎵 按钮开关，轮流循环播放
// ============================================================

const SONGS = [
  { file: 'music/song_01.ogg', title: 'Adele - Someone Like You' },
  { file: 'music/song_02.ogg', title: 'Alec Benjamin - Let Me Down Slowly' },
  { file: 'music/song_03.ogg', title: 'Blue - All Rise' },
  { file: 'music/song_04.ogg', title: 'Britney Spears - Criminal' },
  { file: 'music/song_05.ogg', title: 'Camila Cabello & Young Thug - Havana' },
  { file: 'music/song_06.ogg', title: 'Emily Zeck - Blame It On The Moon' },
  { file: 'music/song_07.ogg', title: 'Fly By Midnight - Lost Without You' },
  { file: 'music/song_08.ogg', title: 'Gotye & Kimbra - Somebody That I Used To Know' },
  { file: 'music/song_09.ogg', title: 'Jewel - Stand' },
  { file: 'music/song_10.ogg', title: 'Karthik & Shreya Ghoshal - Nee Jathaga' },
  { file: 'music/song_11.ogg', title: 'Lady Gaga & Beyoncé - Telephone' },
  { file: 'music/song_12.ogg', title: 'Linkin Park - In the End' },
  { file: 'music/song_13.ogg', title: 'Linkin Park - Numb' },
  { file: 'music/song_14.ogg', title: 'Maty Noyes - in my miNd' },
  { file: 'music/song_15.ogg', title: 'Robinson - Watching You' },
  { file: 'music/song_16.ogg', title: 'Sarvari - Abv' },
  { file: 'music/song_17.ogg', title: 'Sundial - 24' },
  { file: 'music/song_18.ogg', title: 'Taylor Swift - Look What You Made Me Do' },
  { file: 'music/song_19.ogg', title: '廿四味 & 卫兰 - Wonderland' },
  { file: 'music/song_20.ogg', title: '深深的蓝 - 還是會想你 (林達浪)' },
  { file: 'music/song_21.ogg', title: '王菲 - 传奇' },
  { file: 'music/song_22.ogg', title: '王菲 - 匆匆那年' },
  { file: 'music/song_23.ogg', title: '习谱予 & 文颖秋 - Let Me Know' },
  { file: 'music/song_24.ogg', title: '想躲进你的怀里 - 失控 (井迪儿)' },
  { file: 'music/song_25.ogg', title: '张惠妹 - 人质' },
  { file: 'music/song_26.ogg', title: '타이비언 & Dia - 배영하는 물고기' },
];

let musicOn = false;
let songIndex = 0;
let audioEl = null;

function ensureAudio() {
  if (audioEl) return audioEl;
  audioEl = new Audio();
  audioEl.volume = 0.8;
  audioEl.preload = 'auto';
  audioEl.addEventListener('ended', nextSong);
  audioEl.addEventListener('error', function () { if (musicOn) setTimeout(nextSong, 1500); });
  return audioEl;
}

function nextSong() {
  if (!musicOn) return;
  const song = SONGS[songIndex % SONGS.length];
  songIndex++;
  const a = ensureAudio();
  a.src = song.file;
  a.play().catch(function () {});
  if (typeof toast === 'function') toast('🎵 ' + song.title);
}

function toggleMusic() {
  const btn = document.getElementById('musicBtn');
  musicOn = !musicOn;
  const a = ensureAudio();
  if (musicOn) {
    if (btn) btn.classList.remove('off');
    songIndex = songIndex % SONGS.length;
    nextSong();
  } else {
    if (btn) btn.classList.add('off');
    if (a) { a.pause(); a.src = ''; }
  }
}
