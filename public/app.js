(() => {
'use strict';
const $ = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => [...e.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const view = $('#view');
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const STATUS_LABEL = { hadir: 'Hadir', terlambat: 'Terlambat', izin: 'Izin', sakit: 'Sakit', alfa: 'Alfa', belum: 'Belum absen', libur: 'Libur' };
let PUB = null, offset = 0, timers = [], stream = null;
let TOKEN = sessionStorage.getItem('tok') || '';
let WHO = null; try { WHO = JSON.parse(sessionStorage.getItem('who') || 'null'); } catch {}
const clearSession = () => { TOKEN = ''; WHO = null; sessionStorage.removeItem('tok'); sessionStorage.removeItem('who'); };

// ---------- util ----------
function toast(msg, type = '') { const t = $('#toast'); t.textContent = msg; t.className = 'show ' + type; clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 3500); }
function wibParts(ms = Date.now() + offset) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'long' }).formatToParts(new Date(ms));
  const o = {}; p.forEach(x => o[x.type] = x.value); return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}:${o.second}`, hari: o.weekday, y: +o.year, m: +o.month, d: +o.day };
}
const dowOf = ds => new Date(ds + 'T00:00:00Z').getUTCDay();
const fmtDate = ds => { const [y, m, d] = ds.split('-').map(Number); return `${HARI[dowOf(ds)]}, ${d} ${BULAN[m - 1]} ${y}`; };
function winState(S, now, libur = []) {
  if (!S.hariAktif.includes(dowOf(now.date))) return { state: 'libur' };
  if (libur.includes(now.date)) return { state: 'libur' };
  const t = now.time;
  if (t < S.jamBuka + ':00') return { state: 'belum' };
  if (t <= S.batasTepat + ':59') return { state: 'buka' };
  if (t <= S.jamTutup + ':59') return { state: 'terlambat' };
  return { state: 'tutup' };
}
function haversine(a, b, c, d) { const R = 6371000, r = x => x * Math.PI / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
async function api(path, opt = {}) {
  const headers = { ...(opt.body ? { 'Content-Type': 'application/json' } : {}) };
  if (opt.admin) headers.Authorization = 'Bearer ' + TOKEN;
  let r; try { r = await fetch(path, { method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
  catch { throw new Error('Tidak dapat terhubung ke server. Periksa koneksi internet.'); }
  let j = {}; try { j = await r.json(); } catch {}
  if (r.status === 401 && opt.admin) { clearSession(); route(); }
  if (!r.ok || j.ok === false) { const e = new Error(j.error || 'Terjadi kesalahan'); e.data = j; throw e; }
  return j;
}
async function loadPublic() {
  PUB = await api('/api/public');
  offset = PUB.nowMs - Date.now();
  return PUB;
}
function stopAll() { timers.forEach(clearInterval); timers = []; stopCam(); }
function stopCam() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }
const liburDates = () => []; // tanggal libur ditangani server; client hanya estimasi

// ---------- navigasi ----------
const NAV = [['/', '🏠', 'Beranda'], ['/profil', '🏫', 'Profil'], ['/absen', '✅', 'Absen'], ['/info', '📢', 'Info'], ['/admin', '🔐', 'Guru']];
function buildNav() {
  $('#topnav').innerHTML = NAV.map(([h, , l]) => `<a href="#${h}" data-r="${h}">${l}</a>`).join('');
  $('#tabbar').innerHTML = NAV.map(([h, i, l]) => `<a href="#${h}" data-r="${h}" class="${h === '/absen' ? 'cta' : ''}"><span class="ic">${i}</span>${l}</a>`).join('');
}
function markNav(p) { $$('[data-r]').forEach(a => a.classList.toggle('active', a.dataset.r === p)); }

const routes = { '/': pageHome, '/profil': pageProfil, '/info': pageInfo, '/absen': pageAbsen, '/admin': pageAdmin };
async function route() {
  stopAll();
  const p = (location.hash.slice(1).split('?')[0]) || '/';
  const fn = routes[p] || pageHome;
  markNav(routes[p] ? p : '/');
  view.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="margin-top:14px"></div>';
  window.scrollTo(0, 0);
  try { if (!PUB) await loadPublic(); await fn(); }
  catch (e) { view.innerHTML = `<div class="card center"><h2>Gagal memuat</h2><p class="muted">${esc(e.message)}</p><button class="btn" onclick="location.reload()">Muat ulang</button></div>`; }
  view.style.animation = 'none'; void view.offsetWidth; view.style.animation = '';
}
const footer = () => `<footer class="foot">© ${new Date().getFullYear()} ${esc(PUB.sekolah.nama)} · Sistem Absensi Online<br>Zona waktu WIB (Asia/Jakarta)</footer>`;

// ---------- Beranda ----------
function statusInfo(w, S) {
  const m = {
    belum: ['belum', 'Belum dibuka', `Absensi dibuka pukul ${S.jamBuka} WIB`],
    buka: ['buka', 'Absensi dibuka', `Tepat waktu sampai ${S.batasTepat} WIB`],
    terlambat: ['terlambat', 'Terlambat', `Absen masih bisa sampai ${S.jamTutup} WIB (tercatat terlambat)`],
    tutup: ['tutup', 'Absensi ditutup', `Batas ${S.jamTutup} WIB sudah lewat. Hubungi guru piket.`],
    libur: ['libur', 'Hari ini libur', 'Tidak ada kegiatan belajar mengajar']
  };
  return m[w.state];
}
async function pageHome() {
  await loadPublic();
  const s = PUB.sekolah, S = PUB.settings, st = PUB.statistik;
  view.innerHTML = `
  <section class="hero">
    <span class="tag">📍 Tumijajar · Tulang Bawang Barat</span>
    <h1>Absensi Online<br>${esc(s.nama)}</h1>
    <p>${esc(s.slogan || '')}. Catat kehadiran dari HP atau komputer — cepat, tercatat otomatis, dan akurat.</p>
    <div class="clock" id="clk">--:--:--</div><div class="clock-date" id="cdate"></div>
    <div id="winpill"></div>
    <div class="row"><a class="btn gold" href="#/absen">✅ Absen Sekarang</a><a class="btn ghost" href="#/profil">Profil Sekolah</a></div>
  </section>
  <section class="section"><h2>📊 Kehadiran Hari Ini</h2>
    <div class="grid g3" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      <div class="stat" style="--c:var(--ok)"><b>${st.hadir + st.terlambat}</b><span>Hadir</span></div>
      <div class="stat" style="--c:var(--warn)"><b>${st.terlambat}</b><span>Terlambat</span></div>
      <div class="stat" style="--c:var(--info)"><b>${st.izin}</b><span>Izin</span></div>
      <div class="stat" style="--c:#7c3aed"><b>${st.sakit}</b><span>Sakit</span></div>
      <div class="stat" style="--c:var(--muted)"><b>${Math.max(0, st.totalSiswa - st.hadir - st.terlambat - st.izin - st.sakit - st.alfa)}</b><span>Belum absen</span></div>
    </div></section>
  <section class="section"><h2>🧭 Menu Cepat</h2>
    <div class="grid g3" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      ${[['📜', 'Aturan Absensi', 'aturan'], ['🕒', 'Jadwal', 'jadwal'], ['🎨', 'Ekstrakurikuler', 'ekskul'], ['🏛️', 'Fasilitas', 'fasilitas'], ['📞', 'Kontak', 'kontak'], ['❓', 'Bantuan', 'faq']]
        .map(([e, l, k]) => `<a class="tile" style="text-decoration:none;color:inherit" href="#/info?tab=${k}" data-tab="${k}"><span class="e">${e}</span>${l}</a>`).join('')}
    </div></section>
  <section class="section"><h2>📣 Pengumuman</h2>${annHtml()}</section>
  ${footer()}`;
  $$('[data-tab]').forEach(a => a.addEventListener('click', () => sessionStorage.setItem('infotab', a.dataset.tab)));
  const tick = () => {
    const n = wibParts(); $('#clk') && ($('#clk').textContent = n.time);
    $('#cdate') && ($('#cdate').textContent = fmtDate(n.date) + ' · WIB');
    const w = winState(S, n), [cls, ttl, sub] = statusInfo(w, S);
    $('#winpill') && ($('#winpill').innerHTML = `<span class="pill ${cls}" style="font-size:.9rem"><span class="dot"></span>${ttl}</span> <span style="opacity:.9;font-size:.88rem;margin-left:6px">${sub}</span>`);
  };
  tick(); timers.push(setInterval(tick, 1000));
  timers.push(setInterval(() => loadPublic().catch(() => {}), 120000));
}
function annHtml() {
  if (!PUB.pengumuman.length) return '<div class="card muted center">Belum ada pengumuman.</div>';
  return PUB.pengumuman.map(a => `<div class="card" style="margin-bottom:10px"><div class="small muted">${fmtDate(a.tanggal)}</div><h3 style="margin-top:2px">${esc(a.judul)}</h3><p class="muted" style="margin:0;white-space:pre-line">${esc(a.isi)}</p></div>`).join('');
}

// ---------- Profil ----------
async function pageProfil() {
  const s = PUB.sekolah;
  view.innerHTML = `
  <section class="hero" style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
    <img src="/logo.svg" width="92" height="92" alt="Logo" style="border-radius:22px;box-shadow:0 10px 24px -8px #000a">
    <div style="flex:1;min-width:220px"><h1 style="margin-bottom:6px">${esc(s.nama)}</h1><p style="margin:0">${esc(s.slogan || '')}</p><p class="small" style="margin:8px 0 0;opacity:.85">📍 ${esc(s.alamat)}</p></div>
  </section>
  <section class="section card"><h2>Tentang Sekolah</h2><p class="muted">${esc(s.tentang)}</p>${s.kepalaSekolah ? `<p><b>Kepala Sekolah:</b> ${esc(s.kepalaSekolah)}</p>` : ''}</section>
  <section class="section grid g2">
    <div class="card"><h2>🎯 Visi</h2><p class="muted" style="margin:0">${esc(s.visi)}</p></div>
    <div class="card"><h2>🚀 Misi</h2><ul class="list-check">${(s.misi || []).map(m => `<li>${esc(m)}</li>`).join('')}</ul></div>
  </section>
  <section class="section"><h2>📘 Program Unggulan</h2><div class="grid g3">${(s.program || []).map(p => `<div class="card"><h3>${esc(p.judul)}</h3><p class="muted" style="margin:0">${esc(p.isi)}</p></div>`).join('')}</div></section>
  <section class="section"><h2>🎨 Ekstrakurikuler</h2><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">${(s.ekskul || []).map(e => `<div class="tile"><span class="e">${e.ikon || '⭐'}</span>${esc(e.nama)}</div>`).join('')}</div></section>
  ${footer()}`;
}

// ---------- Info interaktif ----------
function pageInfo() {
  const s = PUB.sekolah, S = PUB.settings;
  const k = s.kontak || {};
  const contactRows = [['📞', 'Telepon', k.telepon], ['✉️', 'Email', k.email, k.email && 'mailto:' + k.email], ['🌐', 'Website', k.website, k.website], ['📸', 'Instagram', k.instagram, k.instagram && 'https://instagram.com/' + k.instagram.replace('@', '')], ['📍', 'Alamat', s.alamat, k.maps]]
    .filter(r => r[2]).map(r => `<div class="check"><span class="ico">${r[0]}</span><div class="t"><b>${r[1]}</b>${r[3] ? `<a href="${esc(r[3])}" target="_blank" rel="noopener">${esc(r[2])}</a>` : esc(r[2])}</div></div>`).join('');
  const faqs = [
    ['Lokasi saya ditolak / jauh dari sekolah?', 'Pastikan GPS aktif dan izin lokasi diberikan ke browser. Aktifkan "Akurasi Tinggi", keluar dari bangunan beberapa saat, lalu tekan Cek Lokasi lagi. Absen Hadir hanya bisa dilakukan dalam radius ' + S.radius + ' m dari sekolah.'],
    ['Kamera tidak bisa dibuka?', 'Izinkan akses kamera pada browser (ikon gembok di address bar). Aplikasi ini hanya menerima foto yang diambil langsung dari kamera, bukan dari galeri. Pastikan alamat situs diawali https://.'],
    ['NIS saya tidak terdaftar?', 'Hubungi wali kelas atau admin sekolah untuk memastikan data kamu sudah dimasukkan.'],
    ['Saya sakit / izin, bagaimana?', `Pilih status Izin atau Sakit, isi keterangan, lalu kirim. Pengajuan dapat dilakukan sampai pukul ${S.jamTutupIzin} WIB.`],
    ['Saya terlambat setelah absensi ditutup?', 'Temui guru piket. Guru dapat menginput kehadiran secara manual melalui dashboard.'],
    ['Bisakah dipasang seperti aplikasi?', 'Bisa. Buka menu browser lalu pilih "Tambahkan ke layar utama" / "Install aplikasi".']
  ];
  const tabs = {
    aturan: ['📜 Aturan', `<div class="card"><h2>Aturan Absensi</h2><ul class="list-check">${(s.aturanAbsensi || []).map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>
      <div class="card" style="margin-top:14px"><h3>⏱️ Pengaturan Waktu Absensi</h3><div class="timeline"><div><b>${S.jamBuka}</b> — Absensi dibuka</div><div><b>${S.batasTepat}</b> — Batas tepat waktu</div><div><b>${S.jamTutup}</b> — Absensi ditutup (setelah batas = terlambat)</div><div><b>${S.jamTutupIzin}</b> — Batas pengajuan izin/sakit</div></div></div>`],
    jadwal: ['🕒 Jadwal', `<div class="card"><h2>Jadwal Harian</h2><div class="timeline">${(s.jadwal || []).map(j => `<div><b>${esc(j.jam)}</b> — ${esc(j.kegiatan)}</div>`).join('')}</div><p class="small muted">Hari belajar: ${S.hariAktif.map(d => HARI[d]).join(', ')}</p></div>`],
    ekskul: ['🎨 Ekskul', `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">${(s.ekskul || []).map(e => `<div class="tile"><span class="e">${e.ikon || '⭐'}</span>${esc(e.nama)}</div>`).join('')}</div>`],
    fasilitas: ['🏛️ Fasilitas', `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">${(s.fasilitas || []).map(e => `<div class="tile"><span class="e">${e.ikon || '🏢'}</span>${esc(e.nama)}</div>`).join('')}</div>`],
    pengumuman: ['📣 Pengumuman', annHtml()],
    kontak: ['📞 Kontak', contactRows ? `<div class="card"><h2>Hubungi Kami</h2>${contactRows}</div>` : `<div class="card"><h2>Alamat</h2><p class="muted">${esc(s.alamat)}</p><p class="small muted">Data kontak belum diisi oleh admin sekolah.</p></div>`],
    faq: ['❓ Bantuan', faqs.map(f => `<div class="acc"><button>${esc(f[0])}</button><div>${esc(f[1])}</div></div>`).join('')]
  };
  let cur = (location.hash.match(/tab=(\w+)/) || [])[1] || sessionStorage.getItem('infotab') || 'aturan';
  if (!tabs[cur]) cur = 'aturan';
  view.innerHTML = `<h1 style="font-size:1.7rem">Informasi Sekolah</h1><div class="tabs" id="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-k="${k}">${v[0]}</button>`).join('')}</div><div id="pane"></div>${footer()}`;
  const show = k => {
    sessionStorage.setItem('infotab', k);
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.k === k));
    const pane = $('#pane'); pane.innerHTML = tabs[k][1]; pane.style.animation = 'none'; void pane.offsetWidth; pane.style.animation = 'fade .3s both';
    $$('.acc>button', pane).forEach(b => b.addEventListener('click', () => { const a = b.parentElement, d = b.nextElementSibling; a.classList.toggle('open'); d.style.maxHeight = a.classList.contains('open') ? d.scrollHeight + 30 + 'px' : 0; }));
  };
  $$('#tabs button').forEach(b => b.addEventListener('click', () => show(b.dataset.k)));
  show(cur);
}

// ---------- Absensi (form utama) ----------
let A = {};
async function pageAbsen() {
  view.innerHTML = `<div class="card" id="abs" style="max-width:560px;margin:0 auto"></div>${footer()}`;
  const saved = localStorage.getItem('nis');
  if (saved) await lookup(saved, true); else identity();
}
const absBox = () => $('#abs');
function stepper(n) { return `<div class="steps">${[1, 2, 3].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`; }
function identity(err = '') {
  A = {};
  absBox().innerHTML = `${stepper(1)}<h2>Absensi Siswa</h2><p class="muted">Masukkan NIS kamu. Nama dan kelas akan terisi otomatis.</p>
    ${err ? `<div class="alert bad">${esc(err)}</div>` : ''}
    <label class="f" for="nis">Nomor Induk Siswa (NIS)</label>
    <input class="inp" id="nis" inputmode="numeric" autocomplete="off" placeholder="contoh: 1001" autofocus>
    <div style="margin-top:16px"><button class="btn block" id="go">Lanjutkan →</button></div>`;
  const go = () => lookup($('#nis').value.trim());
  $('#go').onclick = go; $('#nis').onkeydown = e => e.key === 'Enter' && go();
}
async function lookup(nis, silent) {
  if (!nis) return identity('NIS wajib diisi.');
  absBox().innerHTML = '<div class="skeleton"></div>';
  try {
    const d = await api('/api/siswa/' + encodeURIComponent(nis));
    localStorage.setItem('nis', nis);
    A = { nis, ...d, status: 'hadir' };
    d.sudah ? receipt({ ...d.sudah, nama: d.nama, kelas: d.kelas }, true) : form();
  } catch (e) { localStorage.removeItem('nis'); identity(e.message); }
}
function form() {
  const S = PUB.settings, d = A;
  const w = winState(S, wibParts());
  const initials = d.nama.split(' ').slice(0, 2).map(x => x[0]).join('').toUpperCase();
  absBox().innerHTML = `${stepper(3)}
  <div class="me"><div class="avatar">${esc(initials)}</div><div style="flex:1;min-width:0"><b>${esc(d.nama)}</b><div class="small muted">NIS ${esc(d.nis)} · Kelas ${esc(d.kelas)}</div></div><button class="btn light sm" id="chg">Bukan saya</button></div>
  <div class="small muted center" style="margin-top:10px">${fmtDate(wibParts().date)} · <b id="fclk"></b> WIB</div>
  <div id="wmsg"></div>
  <label class="f">Status Kehadiran</label>
  <div class="seg" id="seg">
    <button data-s="hadir" class="on"><span class="e">🙋</span>Hadir</button>
    <button data-s="izin"><span class="e">📝</span>Izin</button>
    <button data-s="sakit"><span class="e">🤒</span>Sakit</button>
  </div>
  <div id="secHadir">
    ${!window.isSecureContext ? '<div class="alert warn">⚠️ Kamera & GPS hanya berfungsi lewat koneksi aman (https://).</div>' : ''}
    ${S.wajibLokasi ? `<label class="f">Lokasi (GPS)</label><div class="check wait" id="locBox"><span class="ico">📍</span><div class="t"><b>Memeriksa lokasi…</b>Izinkan akses lokasi pada browser.</div><button class="btn light sm" id="relocate">Cek lagi</button></div>` : ''}
    ${S.wajibSelfie ? `<label class="f">Foto Selfie</label><div class="cam" id="cam"><div class="ph">📷<br>Foto harus diambil langsung dari kamera</div></div>
    <div class="cam-actions" id="camAct"><button class="btn light" id="openCam">Buka Kamera</button></div>` : ''}
  </div>
  <div id="secIzin" class="hide"><label class="f" for="ket">Keterangan</label><textarea class="inp" id="ket" maxlength="300" placeholder="Tuliskan alasan izin / sakit…"></textarea></div>
  ${S.wajibPin ? `<label class="f" for="pin">PIN</label><input class="inp" id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN dari wali kelas">` : ''}
  <div id="errBox"></div>
  <div style="margin-top:18px"><button class="btn block" id="send">Kirim Absensi</button></div>
  <p class="small muted center" style="margin-top:12px">Waktu dicatat otomatis oleh server sehingga tidak dapat diubah dari HP.</p>`;

  $('#chg').onclick = () => { localStorage.removeItem('nis'); stopCam(); identity(); };
  const tickF = () => { const el = $('#fclk'); if (el) el.textContent = wibParts().time; const m = $('#wmsg'); if (m && $('#seg .on')?.dataset.s === 'hadir') { const w2 = winState(S, wibParts()); m.innerHTML = w2.state === 'buka' ? `<div class="alert ok">Absensi dibuka — tepat waktu sampai ${S.batasTepat} WIB</div>` : w2.state === 'terlambat' ? `<div class="alert warn">Batas tepat waktu lewat. Absen sekarang akan tercatat <b>Terlambat</b> (ditutup ${S.jamTutup} WIB).</div>` : w2.state === 'belum' ? `<div class="alert">Absensi dibuka pukul ${S.jamBuka} WIB.</div>` : w2.state === 'tutup' ? `<div class="alert bad">Absensi hadir sudah ditutup. Kamu masih bisa mengajukan izin/sakit sampai ${S.jamTutupIzin} WIB atau hubungi guru piket.</div>` : `<div class="alert">Hari ini bukan hari belajar.</div>`; } else if (m) m.innerHTML = ''; };
  tickF(); timers.push(setInterval(tickF, 1000));

  $$('#seg button').forEach(b => b.onclick = () => {
    A.status = b.dataset.s; $$('#seg button').forEach(x => x.classList.toggle('on', x === b));
    $('#secHadir').classList.toggle('hide', A.status !== 'hadir'); $('#secIzin').classList.toggle('hide', A.status === 'hadir');
    if (A.status !== 'hadir') stopCam(); tickF();
  });
  if (S.wajibLokasi || true) { locate(); const r = $('#relocate'); if (r) r.onclick = locate; }
  const oc = $('#openCam'); if (oc) oc.onclick = startCam;
  $('#send').onclick = submit;
}
function locate() {
  const S = PUB.settings, box = $('#locBox');
  const set = (cls, ico, t, sub) => { if (!box) return; box.className = 'check ' + cls; box.innerHTML = `<span class="ico">${ico}</span><div class="t"><b>${t}</b>${sub}</div><button class="btn light sm" id="relocate">Cek lagi</button>`; $('#relocate').onclick = locate; };
  if (!navigator.geolocation) return set('bad', '⚠️', 'GPS tidak didukung', 'Gunakan browser lain.');
  set('wait', '📡', 'Mencari lokasi…', 'Mohon tunggu, jangan tutup halaman.');
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    A.lat = lat; A.lng = lng; A.akurasi = Math.round(accuracy);
    if (S.lat != null && S.lng != null) {
      const dist = Math.round(haversine(lat, lng, S.lat, S.lng)); A.jarak = dist;
      const ok = dist <= S.radius + Math.min(accuracy, 50);
      set(ok ? 'ok' : 'bad', ok ? '✅' : '🚫', ok ? 'Kamu berada di lingkungan sekolah' : 'Kamu di luar area sekolah', `Jarak ±${dist} m (batas ${S.radius} m) · akurasi ±${A.akurasi} m`);
    } else set('ok', '✅', 'Lokasi terdeteksi', `Akurasi ±${A.akurasi} m`);
  }, err => {
    A.lat = A.lng = null;
    const m = { 1: 'Izin lokasi ditolak. Aktifkan izin lokasi di pengaturan browser.', 2: 'Lokasi tidak tersedia. Aktifkan GPS.', 3: 'Waktu pencarian lokasi habis. Coba lagi.' }[err.code] || 'Gagal mendapatkan lokasi.';
    set('bad', '⚠️', 'Lokasi belum didapat', m);
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}
async function startCam() {
  const cam = $('#cam'); A.foto = null;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamera tidak didukung. Gunakan https:// dan browser terbaru.');
    stopCam();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 1280 } }, audio: false });
    cam.innerHTML = '<video autoplay playsinline muted></video><div class="frame"></div>';
    const v = $('video', cam); v.srcObject = stream; await v.play().catch(() => {});
    $('#camAct').innerHTML = '<button class="btn" id="snap">📸 Ambil Foto</button>';
    $('#snap').onclick = snap;
  } catch (e) {
    cam.innerHTML = `<div class="ph">🚫<br>${esc(e.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan kamera di pengaturan browser.' : e.message || 'Kamera tidak dapat dibuka')}</div>`;
  }
}
function snap() {
  const v = $('#cam video'); if (!v || !v.videoWidth) return toast('Kamera belum siap', 'bad');
  const W = 480, H = 640, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'), vw = v.videoWidth, vh = v.videoHeight, sc = Math.max(W / vw, H / vh);
  const dw = vw * sc, dh = vh * sc; x.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  const n = wibParts();
  x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, H - 54, W, 54);
  x.fillStyle = '#fff'; x.font = '600 15px system-ui,sans-serif';
  x.fillText(`${n.date.split('-').reverse().join('/')} ${n.time} WIB · NIS ${A.nis}`, 12, H - 32);
  x.font = '13px system-ui,sans-serif'; x.fillText(A.lat != null ? `GPS ${A.lat.toFixed(5)}, ${A.lng.toFixed(5)}` : 'GPS tidak tersedia', 12, H - 12);
  A.foto = c.toDataURL('image/jpeg', 0.72); stopCam();
  $('#cam').innerHTML = `<img src="${A.foto}" alt="Selfie">`;
  $('#camAct').innerHTML = '<button class="btn light" id="openCam">🔄 Ulangi</button>'; $('#openCam').onclick = startCam;
}
async function submit() {
  const S = PUB.settings, btn = $('#send'), err = $('#errBox'); err.innerHTML = '';
  const body = { nis: A.nis, status: A.status, pin: $('#pin')?.value || '' };
  if (A.status === 'hadir') {
    if (S.wajibLokasi && A.lat == null) { err.innerHTML = '<div class="alert bad">Lokasi belum terdeteksi. Aktifkan GPS lalu tekan "Cek lagi".</div>'; return; }
    if (S.wajibSelfie && !A.foto) { err.innerHTML = '<div class="alert bad">Ambil foto selfie terlebih dahulu.</div>'; return; }
    Object.assign(body, { lat: A.lat, lng: A.lng, akurasi: A.akurasi, foto: A.foto });
  } else {
    body.keterangan = $('#ket').value.trim();
    if (!body.keterangan) { err.innerHTML = '<div class="alert bad">Keterangan wajib diisi.</div>'; return; }
    if (A.lat != null) Object.assign(body, { lat: A.lat, lng: A.lng, akurasi: A.akurasi });
  }
  btn.disabled = true; btn.textContent = 'Mengirim…';
  try { const r = await api('/api/absen', { method: 'POST', body }); stopCam(); receipt(r.record, false); }
  catch (e) { err.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = 'Kirim Absensi'; if (e.data?.jarak) locate(); }
}
function receipt(r, already) {
  const cls = r.status;
  absBox().innerHTML = `<div class="receipt">
    <svg class="tick" viewBox="0 0 88 88" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="44" cy="44" r="40" stroke="#16a34a" stroke-width="6"/><path d="M26 45l13 13 24-27" stroke="#16a34a" stroke-width="7"/></svg>
    <h2>${already ? 'Kamu sudah absen hari ini' : 'Absensi Berhasil!'}</h2>
    <span class="pill ${cls}" style="font-size:.95rem">${STATUS_LABEL[r.status] || r.status}</span>
    <div class="kv"><span>Nama</span><b>${esc(r.nama)}</b><span>Kelas</span><b>${esc(r.kelas)}</b><span>Tanggal</span><b>${fmtDate(r.tanggal)}</b><span>Pukul</span><b>${esc(r.waktu)} WIB</b>${r.jarak != null ? `<span>Jarak dari sekolah</span><b>${r.jarak} m</b>` : ''}${r.keterangan ? `<span>Keterangan</span><b>${esc(r.keterangan)}</b>` : ''}</div>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><a class="btn" href="#/">Selesai</a><button class="btn light" id="other">Bukan saya? Ganti NIS</button></div></div>`;
  $('#other').onclick = () => { localStorage.removeItem('nis'); identity(); };
}

// ---------- Dashboard Guru ----------
let adminTab = 'harian';
function pageAdmin() {
  if (!TOKEN || !WHO) return adminLogin();
  const isW = WHO.role === 'wali';
  const tabs = isW
    ? [['harian', '📅 Kelas Saya'], ['rekap', '📈 Rekap'], ['laporan', '🖨️ Laporan PDF']]
    : [['harian', '📅 Hari Ini'], ['rekap', '📈 Rekap'], ['laporan', '🖨️ Laporan PDF'], ['siswa', '👥 Siswa'], ['guru', '👩‍🏫 Wali Kelas'], ['setelan', '⚙️ Pengaturan'], ['umum', '📣 Pengumuman']];
  if (!tabs.some(t => t[0] === adminTab)) adminTab = 'harian';
  view.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><div><h1 style="font-size:1.6rem;margin:0">Dashboard ${isW ? 'Wali Kelas' : 'Admin'}</h1><div class="small muted">${esc(WHO.nama)}${isW ? ' · Kelas ' + esc(WHO.kelas) : ''}</div></div><button class="btn light sm" id="out">Keluar</button></div>
    <div class="tabs" id="atabs" style="margin-top:10px">${tabs.map(t => `<button data-k="${t[0]}">${t[1]}</button>`).join('')}</div><div id="apane"></div>`;
  $('#out').onclick = () => { clearSession(); route(); };
  $$('#atabs button').forEach(b => b.onclick = () => adminShow(b.dataset.k));
  adminShow(adminTab);
}
function adminLogin() {
  view.innerHTML = `<div class="card" style="max-width:420px;margin:30px auto"><div class="center" style="font-size:2.4rem">🔐</div><h2 class="center">Login Guru</h2>
  <div class="seg" style="grid-template-columns:1fr 1fr;margin:12px 0" id="rl"><button data-role="wali" class="on"><span class="e">👩‍🏫</span>Wali Kelas</button><button data-role="admin"><span class="e">🛠️</span>Admin</button></div>
  <div id="ufield"><label class="f" for="un">Username</label><input class="inp" id="un" autocomplete="username" autocapitalize="none"></div>
  <label class="f" for="pw">Password</label><input class="inp" id="pw" type="password" autocomplete="current-password"><div id="lerr"></div>
  <div style="margin-top:16px"><button class="btn block" id="lg">Masuk</button></div>
  <p class="small muted center" style="margin-top:12px">Akun wali kelas dibuat oleh admin sekolah.</p></div>`;
  let role = 'wali';
  $$('#rl button').forEach(b => b.onclick = () => { role = b.dataset.role; $$('#rl button').forEach(x => x.classList.toggle('on', x === b)); $('#ufield').classList.toggle('hide', role === 'admin'); });
  const go = async () => {
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { username: role === 'wali' ? $('#un').value : '', password: $('#pw').value } });
      TOKEN = r.token; WHO = { role: r.role, nama: r.nama, kelas: r.kelas };
      sessionStorage.setItem('tok', TOKEN); sessionStorage.setItem('who', JSON.stringify(WHO)); adminTab = 'harian'; route();
    } catch (e) { $('#lerr').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
  };
  $('#lg').onclick = go; $('#pw').onkeydown = e => e.key === 'Enter' && go();
}
function adminShow(k) {
  adminTab = k; $$('#atabs button').forEach(b => b.classList.toggle('active', b.dataset.k === k));
  const pane = $('#apane'); pane.innerHTML = '<div class="skeleton"></div>';
  ({ harian: tabHarian, rekap: tabRekap, siswa: tabSiswa, setelan: tabSetelan, umum: tabUmum, guru: tabGuru, laporan: tabLaporan })[k](pane).catch(e => { pane.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; });
}
const kelasOpts = (list, sel = '') => `<option value="">Semua kelas</option>` + list.map(k => `<option ${k === sel ? 'selected' : ''}>${esc(k)}</option>`).join('');

async function tabHarian(pane) {
  let tgl = wibParts().date, kelas = '', q = '', filt = '';
  const load = async () => {
    const d = await api(`/api/admin/harian?tanggal=${tgl}&kelas=${encodeURIComponent(kelas)}`, { admin: true });
    const cnt = { hadir: 0, terlambat: 0, izin: 0, sakit: 0, alfa: 0, belum: 0, libur: 0 }; d.rows.forEach(r => cnt[r.status]++);
    const S = PUB.settings;
    const waBtn = r => r.status === 'alfa' ? (r.hp ? `<button class="btn sm ${r.waSent ? 'light' : ''}" data-wa="${esc(r.nis)}">💬 ${r.waSent ? 'Terkirim ✓' : 'WA Ortu'}</button> ` : '<span class="small muted" title="Isi No. HP orang tua di menu Siswa">no HP ortu</span> ') : '';
    const warn = (WHO.role === 'admin' && S.wajibLokasi && S.lat == null) ? '<div class="alert warn">⚠️ Koordinat sekolah belum diatur — validasi lokasi belum aktif. Buka tab <b>Pengaturan</b> dan tekan "Gunakan lokasi saya".</div>' : '';
    pane.innerHTML = `${warn}
    <div class="toolbar"><input class="inp" type="date" id="tg" value="${tgl}">${WHO.role === 'wali' ? `<span class="pill izin">Kelas ${esc(WHO.kelas)}</span>` : `<select class="inp" id="kl">${kelasOpts(d.kelasList, kelas)}</select>`}<input class="inp" id="q" placeholder="Cari nama / NIS" value="${esc(q)}" style="flex:1;min-width:140px"><button class="btn light sm" id="rf">⟳ Segarkan</button></div>
    <div class="toolbar" id="chips">${[['', 'Semua', d.rows.length], ['hadir', 'Hadir', cnt.hadir], ['terlambat', 'Terlambat', cnt.terlambat], ['izin', 'Izin', cnt.izin], ['sakit', 'Sakit', cnt.sakit], ['alfa', 'Alfa', cnt.alfa], ['belum', 'Belum', cnt.belum]].map(([k, l, n]) => `<button class="btn sm ${filt === k ? '' : 'light'}" data-f="${k}">${l} · ${n}</button>`).join('')}</div>
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Nama</th><th>Kelas</th><th>Status</th><th>Jam</th><th>Jarak</th><th>Foto</th><th>Keterangan</th><th>Ubah</th></tr></thead><tbody>
    ${d.rows.filter(r => (!filt || r.status === filt) && (!q || (r.nama + r.nis).toLowerCase().includes(q.toLowerCase()))).map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(r.nama)}</b><div class="small muted">${esc(r.nis)}</div></td><td>${esc(r.kelas)}</td>
      <td><span class="pill ${r.status}">${STATUS_LABEL[r.status]}</span>${r.sumber === 'guru' ? ' <span title="Diubah guru">✏️</span>' : ''}</td><td>${esc(r.waktu || '—')}</td>
      <td>${r.jarak != null ? (r.lat != null ? `<a target="_blank" rel="noopener" href="https://maps.google.com/?q=${r.lat},${r.lng}">${r.jarak} m</a>` : r.jarak + ' m') : '—'}</td>
      <td>${r.foto ? `<img class="thumb" loading="lazy" src="/foto/${r.foto}?t=${encodeURIComponent(TOKEN)}" data-big="/foto/${r.foto}?t=${encodeURIComponent(TOKEN)}" data-cap="${esc(r.nama)}">` : '—'}</td>
      <td style="white-space:normal;min-width:120px">${esc(r.keterangan)}</td>
      <td>${waBtn(r)}<select class="inp" style="padding:6px;width:118px" data-nis="${esc(r.nis)}"><option value="">…</option>${['hadir', 'terlambat', 'izin', 'sakit', 'alfa'].map(s => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join('')}${!r.otomatis ? '<option value="__del">Hapus catatan</option>' : ''}</select></td></tr>`).join('') || '<tr><td colspan="9" class="center muted">Tidak ada data</td></tr>'}
    </tbody></table></div>`;
    $('#tg').onchange = e => { tgl = e.target.value; load(); }; if ($('#kl')) $('#kl').onchange = e => { kelas = e.target.value; load(); };
    $('#rf').onclick = load; $('#q').oninput = e => { q = e.target.value; clearTimeout(load.t); load.t = setTimeout(() => { const pos = $('#q').selectionStart; load().then(() => { const el = $('#q'); el.focus(); el.setSelectionRange(pos, pos); }); }, 250); };
    $$('#chips button').forEach(b => b.onclick = () => { filt = b.dataset.f; load(); });
    $$('[data-wa]').forEach(b => b.onclick = () => {
      const r = d.rows.find(x => x.nis === b.dataset.wa); if (!r) return;
      const msg = (d.waTemplate || '').split('{nama}').join(r.nama).split('{kelas}').join(r.kelas).split('{tanggal}').join(fmtDate(tgl));
      window.open('https://wa.me/' + r.hp + '?text=' + encodeURIComponent(msg), '_blank', 'noopener');
      api('/api/admin/wa-log', { method: 'POST', admin: true, body: { nis: r.nis, tanggal: tgl } }).then(load).catch(e => toast(e.message, 'bad'));
    });
    $$('.thumb').forEach(i => i.onclick = () => { const m = $('#modal'); m.hidden = false; m.innerHTML = `<div class="box"><img src="${i.dataset.big}" alt=""><p class="center" style="margin:10px 0 0"><b>${i.dataset.cap}</b></p><button class="btn block light" style="margin-top:10px" id="mc">Tutup</button></div>`; m.onclick = ev => { if (ev.target === m || ev.target.id === 'mc') m.hidden = true; }; });
    $$('select[data-nis]').forEach(sel => sel.onchange = async () => {
      const v = sel.value; if (!v) return;
      try {
        if (v === '__del') { if (!confirm('Hapus catatan absensi ini?')) return; await api(`/api/admin/absen?nis=${encodeURIComponent(sel.dataset.nis)}&tanggal=${tgl}`, { method: 'DELETE', admin: true }); }
        else { const ket = (v === 'izin' || v === 'sakit') ? (prompt('Keterangan (opsional):') || '') : 'Diinput guru'; await api('/api/admin/absen', { method: 'PUT', admin: true, body: { nis: sel.dataset.nis, tanggal: tgl, status: v, keterangan: ket } }); }
        toast('Tersimpan', 'ok'); load();
      } catch (e) { toast(e.message, 'bad'); }
    });
  };
  await load();
}
async function tabRekap(pane) {
  const n = wibParts(); let from = n.date.slice(0, 8) + '01', to = n.date, kelas = '';
  const load = async () => {
    const d = await api(`/api/admin/rekap?from=${from}&to=${to}&kelas=${encodeURIComponent(kelas)}`, { admin: true });
    pane.innerHTML = `<div class="toolbar"><label class="small muted">Dari</label><input class="inp" type="date" id="f" value="${from}"><label class="small muted">Sampai</label><input class="inp" type="date" id="t" value="${to}">${WHO.role === 'wali' ? `<span class="pill izin">Kelas ${esc(WHO.kelas)}</span>` : `<select class="inp" id="kl">${kelasOpts(d.kelasList || [], kelas)}</select>`}<button class="btn sm" id="ex">⬇ Rekap (CSV)</button><button class="btn light sm" id="exl">⬇ Log Harian (CSV)</button></div>
    <p class="small muted">Hari efektif (hari belajar yang sudah selesai): <b>${d.hariEfektif}</b>. Alfa dihitung otomatis dari hari efektif tanpa catatan.</p>
    <div class="tbl-wrap"><table><thead><tr><th>#</th><th>Nama</th><th>Kelas</th><th class="num">Hadir</th><th class="num">Telat</th><th class="num">Izin</th><th class="num">Sakit</th><th class="num">Alfa</th><th>Kehadiran</th></tr></thead><tbody>
    ${d.rows.map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(r.nama)}</b><div class="small muted">${esc(r.nis)}</div></td><td>${esc(r.kelas)}</td><td class="num">${r.hadir}</td><td class="num">${r.terlambat}</td><td class="num">${r.izin}</td><td class="num">${r.sakit}</td><td class="num"><b style="color:${r.alfa ? 'var(--bad)' : 'inherit'}">${r.alfa}</b></td><td><div style="display:flex;align-items:center;gap:8px"><div class="bar" style="flex:1"><i style="width:${r.persen}%"></i></div><b>${r.persen}%</b></div></td></tr>`).join('') || '<tr><td colspan="9" class="center muted">Tidak ada data</td></tr>'}</tbody></table></div>`;
    $('#f').onchange = e => { from = e.target.value; load(); }; $('#t').onchange = e => { to = e.target.value; load(); }; if ($('#kl')) $('#kl').onchange = e => { kelas = e.target.value; load(); };
    $('#exl').onclick = async () => {
      try { const r = await fetch(`/api/admin/export-log?from=${from}&to=${to}&kelas=${encodeURIComponent(kelas)}`, { headers: { Authorization: 'Bearer ' + TOKEN } }); if (!r.ok) throw new Error('Gagal mengunduh'); const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `log_${from}_${to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } catch (e) { toast(e.message, 'bad'); }
    };
    $('#ex').onclick = async () => {
      try { const r = await fetch(`/api/admin/export?from=${from}&to=${to}&kelas=${encodeURIComponent(kelas)}`, { headers: { Authorization: 'Bearer ' + TOKEN } }); if (!r.ok) throw new Error('Gagal mengunduh'); const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `rekap_${from}_${to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); } catch (e) { toast(e.message, 'bad'); }
    };
  };
  await load();
}
async function tabSiswa(pane) {
  const load = async () => {
    const d = await api('/api/admin/siswa', { admin: true });
    pane.innerHTML = `<div class="card"><h3>Tambah / Ubah Siswa</h3><div class="toolbar"><input class="inp" id="sn" placeholder="NIS"><input class="inp" id="sm" placeholder="Nama lengkap" style="flex:1;min-width:160px"><input class="inp" id="sk" placeholder="Kelas (X IPA 1)" style="width:130px"><select class="inp" id="sj"><option value="">JK</option><option>L</option><option>P</option></select><input class="inp" id="sp" placeholder="PIN (ops.)" style="width:100px"><input class="inp" id="sh" placeholder="HP ortu (08…)" inputmode="tel" style="width:150px"><button class="btn sm" id="sa">Simpan</button></div>
      <h3 style="margin-top:14px">Impor Massal (CSV)</h3><p class="small muted">Kolom: <code>nis,nama,kelas,jk,pin,hp_ortu</code> (jk, pin, hp_ortu opsional; kosongkan dengan koma berurutan, mis. <code>1001,Budi,X IPA 1,L,,0812…</code>). Pemisah koma, titik koma, atau tab. Data dengan NIS sama akan diperbarui.</p><input type="file" id="fi" accept=".csv,.txt"></div>
    <p class="small muted" style="margin-top:14px">Total siswa aktif: <b>${d.rows.length}</b></p>
    <div class="tbl-wrap"><table><thead><tr><th>NIS</th><th>Nama</th><th>Kelas</th><th>JK</th><th>PIN</th><th>HP Ortu</th><th></th></tr></thead><tbody>${d.rows.map(r => `<tr><td>${esc(r.nis)}</td><td>${esc(r.nama)}</td><td>${esc(r.kelas)}</td><td>${esc(r.jk)}</td><td>${r.pin ? '••••' : '—'}</td><td>${r.hp_ortu ? esc(r.hp_ortu) : '—'}</td><td><button class="btn danger sm" data-del="${esc(r.nis)}">Hapus</button></td></tr>`).join('')}</tbody></table></div>`;
    $('#sa').onclick = async () => { try { await api('/api/admin/siswa', { method: 'POST', admin: true, body: { nis: $('#sn').value, nama: $('#sm').value, kelas: $('#sk').value, jk: $('#sj').value, pin: $('#sp').value, hp: $('#sh').value } }); toast('Tersimpan', 'ok'); load(); } catch (e) { toast(e.message, 'bad'); } };
    $('#fi').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const r = await api('/api/admin/siswa/import', { method: 'POST', admin: true, body: { csv: await f.text() } }); toast(`${r.diimpor} siswa diimpor, ${r.dilewati} dilewati`, 'ok'); load(); } catch (er) { toast(er.message, 'bad'); } };
    $$('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Nonaktifkan siswa ini? Riwayat absensi tetap tersimpan.')) return; try { await api('/api/admin/siswa/' + encodeURIComponent(b.dataset.del), { method: 'DELETE', admin: true }); load(); } catch (e) { toast(e.message, 'bad'); } });
  };
  await load();
}
async function tabSetelan(pane) {
  const { settings: s } = await api('/api/admin/settings', { admin: true });
  pane.innerHTML = `<div class="card"><h3>⏱️ Waktu Absensi (WIB)</h3><div class="grid g2">
    <div><label class="f">Absensi dibuka</label><input class="inp" type="time" id="jb" value="${s.jamBuka}"></div>
    <div><label class="f">Batas tepat waktu</label><input class="inp" type="time" id="bt" value="${s.batasTepat}"></div>
    <div><label class="f">Absensi ditutup (batas terlambat)</label><input class="inp" type="time" id="jt" value="${s.jamTutup}"></div>
    <div><label class="f">Batas pengajuan izin/sakit</label><input class="inp" type="time" id="ji" value="${s.jamTutupIzin}"></div></div>
    <label class="f">Hari belajar</label><div class="days">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" class="hr" value="${d}" ${s.hariAktif.includes(d) ? 'checked' : ''}>${HARI[d]}</label>`).join('')}</div>
    <label class="f">Hari libur / tanggal merah <span class="muted small">(satu per baris: <code>2026-12-25 Natal</code>)</span></label>
    <textarea class="inp" id="lb" placeholder="2026-12-25 Hari Natal">${s.libur.map(l => l.tanggal + ' ' + l.ket).join('\n')}</textarea></div>
  <div class="card" style="margin-top:14px"><h3>📍 Lokasi Sekolah</h3><p class="small muted">Titik pusat untuk validasi absen Hadir. Berdirilah di tengah sekolah lalu tekan tombol di bawah.</p>
    <div class="grid g3"><div><label class="f">Latitude</label><input class="inp" id="la" value="${s.lat ?? ''}" inputmode="decimal"></div><div><label class="f">Longitude</label><input class="inp" id="lo" value="${s.lng ?? ''}" inputmode="decimal"></div><div><label class="f">Radius (meter)</label><input class="inp" id="rd" type="number" min="20" max="5000" value="${s.radius}"></div></div>
    <div style="margin-top:10px"><button class="btn light sm" id="gps">📡 Gunakan lokasi saya sekarang</button></div></div>
  <div class="card" style="margin-top:14px"><h3>🛡️ Validasi</h3>
    <div class="switch"><span><b>Wajib GPS</b><br><span class="small muted">Absen Hadir harus dalam radius sekolah</span></span><input type="checkbox" id="wl" ${s.wajibLokasi ? 'checked' : ''}></div>
    <div class="switch"><span><b>Wajib selfie</b><br><span class="small muted">Foto langsung dari kamera</span></span><input type="checkbox" id="ws" ${s.wajibSelfie ? 'checked' : ''}></div>
    <div class="switch"><span><b>Wajib PIN siswa</b><br><span class="small muted">Cegah titip absen (PIN diisi di data siswa)</span></span><input type="checkbox" id="wp" ${s.wajibPin ? 'checked' : ''}></div></div>
  <div class="card" style="margin-top:14px"><h3>💬 Pesan WhatsApp ke Orang Tua</h3><p class="small muted">Dipakai tombol "WA Ortu" pada siswa alfa. Gunakan <code>{nama}</code>, <code>{kelas}</code>, <code>{tanggal}</code>. Pesan dikirim dari WhatsApp guru yang menekan tombol (WhatsApp terbuka dengan pesan siap kirim).</p><textarea class="inp" id="wt" maxlength="600" style="min-height:120px">${esc(s.waTemplate)}</textarea></div>
  <div style="margin-top:16px"><button class="btn block" id="save">💾 Simpan Pengaturan</button></div>`;
  $('#gps').onclick = () => { if (!navigator.geolocation) return toast('GPS tidak didukung', 'bad'); toast('Mencari lokasi…'); navigator.geolocation.getCurrentPosition(p => { $('#la').value = p.coords.latitude.toFixed(6); $('#lo').value = p.coords.longitude.toFixed(6); toast(`Lokasi terisi (akurasi ±${Math.round(p.coords.accuracy)} m)`, 'ok'); }, () => toast('Gagal mengambil lokasi', 'bad'), { enableHighAccuracy: true, timeout: 20000 }); };
  $('#save').onclick = async () => {
    const libur = $('#lb').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => ({ tanggal: l.slice(0, 10), ket: l.slice(10).trim() }));
    try {
      await api('/api/admin/settings', { method: 'PUT', admin: true, body: { jamBuka: $('#jb').value, batasTepat: $('#bt').value, jamTutup: $('#jt').value, jamTutupIzin: $('#ji').value, hariAktif: $$('.hr:checked').map(x => +x.value), libur, lat: $('#la').value.trim() === '' ? null : $('#la').value, lng: $('#lo').value.trim() === '' ? null : $('#lo').value, radius: $('#rd').value, wajibLokasi: $('#wl').checked, wajibSelfie: $('#ws').checked, wajibPin: $('#wp').checked, waTemplate: $('#wt').value } });
      await loadPublic(); toast('Pengaturan disimpan', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  };
}
async function tabGuru(pane) {
  const load = async () => {
    const d = await api('/api/admin/guru', { admin: true });
    pane.innerHTML = `<div class="card"><h3>Tambah / Ubah Wali Kelas</h3><p class="small muted">Wali kelas hanya dapat melihat &amp; mengoreksi absensi kelasnya, melihat foto, mengirim WA ke orang tua, dan mengunduh laporan. Untuk mengubah data tanpa mengganti password, kosongkan kolom password.</p>
    <div class="toolbar"><input class="inp" id="gu" placeholder="username" autocapitalize="none" style="width:130px"><input class="inp" id="gn" placeholder="Nama (beserta gelar)" style="flex:1;min-width:170px"><input class="inp" id="gk" list="kl-list" placeholder="Kelas (sama persis dgn data siswa)" style="width:200px"><datalist id="kl-list">${d.kelasList.map(k => `<option value="${esc(k)}">`).join('')}</datalist><input class="inp" id="gp" type="password" placeholder="Password (min. 6)" autocomplete="new-password" style="width:160px"><button class="btn sm" id="gs">Simpan</button></div></div>
    <div class="tbl-wrap" style="margin-top:14px"><table><thead><tr><th>Username</th><th>Nama</th><th>Kelas</th><th></th></tr></thead><tbody>${d.rows.map(r => `<tr><td>${esc(r.username)}</td><td>${esc(r.nama)}</td><td>${esc(r.kelas)}</td><td><button class="btn light sm" data-edit="${esc(r.username)}|${esc(r.nama)}|${esc(r.kelas)}">Ubah</button> <button class="btn danger sm" data-del="${esc(r.username)}">Hapus</button></td></tr>`).join('') || '<tr><td colspan="4" class="center muted">Belum ada akun wali kelas</td></tr>'}</tbody></table></div>`;
    $('#gs').onclick = async () => { try { await api('/api/admin/guru', { method: 'POST', admin: true, body: { username: $('#gu').value, nama: $('#gn').value, kelas: $('#gk').value, password: $('#gp').value } }); toast('Tersimpan', 'ok'); load(); } catch (e) { toast(e.message, 'bad'); } };
    $$('[data-edit]').forEach(b => b.onclick = () => { const [u, n, k] = b.dataset.edit.split('|'); $('#gu').value = u; $('#gn').value = n; $('#gk').value = k; $('#gp').value = ''; $('#gn').focus(); });
    $$('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Hapus akun wali kelas ini?')) return; try { await api('/api/admin/guru/' + encodeURIComponent(b.dataset.del), { method: 'DELETE', admin: true }); load(); } catch (e) { toast(e.message, 'bad'); } });
  };
  await load();
}
async function tabLaporan(pane) {
  const isW = WHO.role === 'wali';
  const kelasList = isW ? [WHO.kelas] : (await api('/api/admin/harian', { admin: true })).kelasList;
  pane.innerHTML = `<div class="card"><h3>🖨️ Laporan Bulanan (PDF)</h3><p class="small muted">Format A4 landscape: daftar hadir per tanggal (H/T/I/S/A), total per siswa, rata-rata kehadiran, dan kolom tanda tangan kepala sekolah &amp; wali kelas. Hari yang belum selesai tidak dihitung alfa.</p>
  <div class="toolbar"><input class="inp" type="month" id="lb" value="${wibParts().date.slice(0, 7)}">${isW ? `<span class="pill izin">Kelas ${esc(WHO.kelas)}</span>` : `<select class="inp" id="lk">${kelasList.map(k => `<option>${esc(k)}</option>`).join('')}</select>`}<button class="btn" id="dl">⬇ Unduh PDF</button></div></div>`;
  if (!isW) {
    const { key } = await api('/api/admin/feed', { admin: true });
    const base = location.origin + '/api/feed/';
    const f = (kind) => `=IMPORTDATA("${base}${kind}.csv?key=${key}")`;
    const box = document.createElement('div'); box.className = 'card'; box.style.marginTop = '14px';
    box.innerHTML = `<h3>📊 Sambungkan ke Google Sheets / Excel</h3>
      <p class="small muted">Data absensi mengalir otomatis ke spreadsheet tanpa unduh manual. Buka Google Sheets, klik sel A1, lalu tempel salah satu rumus di bawah. Isi tabel akan diperbarui sendiri (Google biasanya menyegarkan tiap beberapa menit hingga ±1 jam). Bulan berjalan dipakai otomatis; tambahkan <code>&amp;from=2026-07-01&amp;to=2026-12-31</code> atau <code>&amp;kelas=X%20IPA%201</code> bila perlu.</p>
      <label class="f">Log kehadiran harian (1 baris per absen: tanggal, jam, NIS, nama, status, jarak, koordinat)</label>
      <div class="toolbar"><input class="inp" readonly id="f1" style="flex:1;min-width:200px" value='${esc(f('harian'))}'><button class="btn light sm" data-copy="f1">Salin</button></div>
      <label class="f">Rekap per siswa (hadir, terlambat, izin, sakit, alfa, persen)</label>
      <div class="toolbar"><input class="inp" readonly id="f2" style="flex:1;min-width:200px" value='${esc(f('rekap'))}'><button class="btn light sm" data-copy="f2">Salin</button></div>
      <div class="alert warn">🔒 Link ini berisi <b>kunci rahasia</b> dan memuat nama siswa. Jangan dibagikan ke publik. Jika bocor, tekan "Ganti kunci" lalu tempel ulang rumus. Server harus dapat diakses dari internet (HTTPS) agar Google Sheets bisa membacanya.</div>
      <button class="btn danger sm" id="rot">Ganti kunci</button>`;
    pane.appendChild(box);
    $$('[data-copy]', box).forEach(b => b.onclick = async () => { const el = $('#' + b.dataset.copy); el.select(); try { await navigator.clipboard.writeText(el.value); toast('Rumus disalin', 'ok'); } catch { document.execCommand('copy'); toast('Rumus disalin', 'ok'); } });
    $('#rot').onclick = async () => { if (!confirm('Ganti kunci? Rumus lama di spreadsheet akan berhenti bekerja.')) return; try { await api('/api/admin/feed/rotate', { method: 'POST', admin: true }); toast('Kunci diganti', 'ok'); tabLaporan(pane); } catch (e) { toast(e.message, 'bad'); } };
  }
  $('#dl').onclick = async () => {
    const btn = $('#dl'); btn.disabled = true;
    try {
      const kelas = isW ? WHO.kelas : $('#lk').value, bulan = $('#lb').value;
      const r = await fetch(`/api/admin/laporan.pdf?bulan=${encodeURIComponent(bulan)}&kelas=${encodeURIComponent(kelas)}`, { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (!r.ok) { let m = 'Gagal membuat laporan'; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
      const b = await r.blob(), a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `laporan_${kelas.replace(/\W+/g, '_')}_${bulan}.pdf`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } catch (e) { toast(e.message, 'bad'); } finally { btn.disabled = false; }
  };
}
async function tabUmum(pane) {
  await loadPublic();
  pane.innerHTML = `<div class="card"><h3>Buat Pengumuman</h3><label class="f">Judul</label><input class="inp" id="aj" maxlength="120"><label class="f">Isi</label><textarea class="inp" id="ai" maxlength="1000"></textarea><div style="margin-top:12px"><button class="btn" id="ap">Terbitkan</button></div></div>
  <div style="margin-top:14px">${PUB.pengumuman.map(a => `<div class="card" style="margin-bottom:10px;display:flex;gap:10px;justify-content:space-between;align-items:flex-start"><div><div class="small muted">${fmtDate(a.tanggal)}</div><b>${esc(a.judul)}</b><p class="muted" style="margin:4px 0 0;white-space:pre-line">${esc(a.isi)}</p></div><button class="btn danger sm" data-d="${a.id}">Hapus</button></div>`).join('') || '<p class="muted">Belum ada pengumuman.</p>'}</div>`;
  $('#ap').onclick = async () => { try { await api('/api/admin/pengumuman', { method: 'POST', admin: true, body: { judul: $('#aj').value, isi: $('#ai').value } }); toast('Diterbitkan', 'ok'); tabUmum(pane); } catch (e) { toast(e.message, 'bad'); } };
  $$('[data-d]').forEach(b => b.onclick = async () => { if (!confirm('Hapus pengumuman?')) return; await api('/api/admin/pengumuman/' + b.dataset.d, { method: 'DELETE', admin: true }); tabUmum(pane); });
}

// ---------- init ----------
function initTheme() {
  const t = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
  $('#themeBtn').onclick = () => { const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; localStorage.setItem('theme', n); $('meta[name=theme-color]').content = n === 'dark' ? '#0a1224' : '#0b2a5b'; };
}
initTheme(); buildNav();
window.addEventListener('hashchange', route); route();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
})();
