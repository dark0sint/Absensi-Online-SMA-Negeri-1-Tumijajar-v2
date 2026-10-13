'use strict';
/**
 * Absensi Siswa SMA Negeri 1 Tumijajar
 * Server tanpa dependensi eksternal. Membutuhkan Node.js >= 22.13 (SQLite bawaan).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- Konfigurasi ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TZ = 'Asia/Jakarta';

fs.mkdirSync(path.join(DATA_DIR, 'foto'), { recursive: true });
if (ADMIN_PASSWORD === 'admin123') console.warn('[PERINGATAN] ADMIN_PASSWORD masih default. Segera ganti lewat environment variable!');

// secret sesi (persisten)
const secretFile = path.join(DATA_DIR, 'secret.key');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();

// ---------- Database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'absensi.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS students(
  nis TEXT PRIMARY KEY, nama TEXT NOT NULL, kelas TEXT NOT NULL,
  jk TEXT DEFAULT '', pin TEXT DEFAULT '', aktif INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS attendance(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nis TEXT NOT NULL, tanggal TEXT NOT NULL, waktu TEXT NOT NULL,
  status TEXT NOT NULL, keterangan TEXT DEFAULT '',
  lat REAL, lng REAL, akurasi REAL, jarak REAL,
  foto TEXT DEFAULT '', ip TEXT DEFAULT '', ua TEXT DEFAULT '', sumber TEXT DEFAULT 'siswa',
  UNIQUE(nis, tanggal)
);
CREATE INDEX IF NOT EXISTS idx_att_tgl ON attendance(tanggal);
CREATE TABLE IF NOT EXISTS announcements(
  id INTEGER PRIMARY KEY AUTOINCREMENT, judul TEXT NOT NULL, isi TEXT NOT NULL, tanggal TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teachers(
  username TEXT PRIMARY KEY, nama TEXT NOT NULL, kelas TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_log(
  nis TEXT NOT NULL, tanggal TEXT NOT NULL, waktu TEXT NOT NULL, oleh TEXT DEFAULT '', PRIMARY KEY(nis, tanggal)
);
`);
if (!db.prepare('PRAGMA table_info(students)').all().some(c => c.name === 'hp_ortu')) db.exec("ALTER TABLE students ADD COLUMN hp_ortu TEXT DEFAULT ''");

const DEFAULT_SETTINGS = {
  jamBuka: '06:00', batasTepat: '07:15', jamTutup: '08:30', jamTutupIzin: '12:00',
  hariAktif: [1, 2, 3, 4, 5],
  lat: null, lng: null, radius: 150,
  wajibLokasi: true, wajibSelfie: true, wajibPin: false,
  libur: [],
  waTemplate: 'Assalamualaikum Bapak/Ibu. Kami dari SMA Negeri 1 Tumijajar menginformasikan bahwa ananda {nama} (kelas {kelas}) tercatat TIDAK HADIR tanpa keterangan (alfa) pada {tanggal}. Mohon konfirmasi alasan ketidakhadiran ananda kepada wali kelas. Terima kasih.'
};
function getSettings() {
  const r = db.prepare("SELECT v FROM kv WHERE k='settings'").get();
  return { ...DEFAULT_SETTINGS, ...(r ? JSON.parse(r.v) : {}) };
}
function saveSettings(s) {
  db.prepare("INSERT INTO kv(k,v) VALUES('settings',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(JSON.stringify(s));
}
function getSchool() {
  const f = path.join(DATA_DIR, 'school.json');
  if (!fs.existsSync(f)) fs.copyFileSync(path.join(__dirname, 'school.default.json'), f);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return JSON.parse(fs.readFileSync(path.join(__dirname, 'school.default.json'), 'utf8')); }
}

// Data contoh (hanya bila tabel siswa kosong)
if (db.prepare('SELECT COUNT(*) c FROM students').get().c === 0 && process.env.SEED_DEMO !== '0') {
  const ins = db.prepare('INSERT INTO students(nis,nama,kelas,jk) VALUES(?,?,?,?)');
  [['1001', 'Contoh Siswa Satu', 'X IPA 1', 'L'], ['1002', 'Contoh Siswi Dua', 'X IPA 1', 'P'],
   ['1003', 'Contoh Siswa Tiga', 'XI IPS 1', 'L'], ['1004', 'Contoh Siswi Empat', 'XI IPS 1', 'P'],
   ['1005', 'Contoh Siswa Lima', 'XII IPA 1', 'L']].forEach(r => ins.run(...r));
  console.log('[INFO] Data siswa contoh dibuat (NIS 1001-1005). Hapus/ganti lewat dashboard guru.');
}

// ---------- Utilitas waktu ----------
function wib(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const o = {}; parts.forEach(p => o[p.type] = p.value);
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}:${o.second}` };
}
const dow = ds => new Date(ds + 'T00:00:00Z').getUTCDay();
const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s + 'T00:00:00Z'));
const isHM = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');

function isSchoolDay(S, ds) {
  return S.hariAktif.includes(dow(ds)) && !S.libur.some(l => l.tanggal === ds);
}
function windowState(S, now) {
  if (!isSchoolDay(S, now.date)) return { state: 'libur', libur: S.libur.find(l => l.tanggal === now.date)?.ket || '' };
  const t = now.time;
  if (t < S.jamBuka + ':00') return { state: 'belum' };
  if (t <= S.batasTepat + ':59') return { state: 'buka' };
  if (t <= S.jamTutup + ':59') return { state: 'terlambat' };
  return { state: 'tutup' };
}
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- Auth ----------
function sign(payload) { return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url'); }
function makeToken(p) {
  const body = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url');
  return body + '.' + sign(body);
}
function verifyToken(t) {
  if (!t || typeof t !== 'string') return null;
  const [p, sg] = t.split('.');
  if (!p || !sg) return null;
  const e = sign(p);
  if (sg.length !== e.length || !crypto.timingSafeEqual(Buffer.from(sg), Buffer.from(e))) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) { return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') }; }
function checkPw(pw, salt, hash) {
  const h = crypto.scryptSync(String(pw), salt, 32), e = Buffer.from(hash, 'hex');
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}
const normHp = v => { let d = String(v || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '62' + d.slice(1); else if (d.startsWith('8')) d = '62' + d; return d.slice(0, 16); };
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- Rate limit ----------
const hits = new Map();
function limited(key, max, windowMs = 60000) {
  const n = Date.now();
  const arr = (hits.get(key) || []).filter(t => n - t < windowMs);
  arr.push(n); hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (!v.some(t => n - t < 60000)) hits.delete(k); }, 60000).unref();

// ---------- HTTP helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const fail = (res, code, msg, extra = {}) => send(res, code, { ok: false, error: msg, ...extra });
function readBody(req, limit = 1.5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Data terlalu besar'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(Object.assign(new Error('JSON tidak valid'), { code: 400 })); } });
    req.on('error', reject);
  });
}
function clientIp(req) {
  if (TRUST_PROXY) { const x = req.headers['x-forwarded-for']; if (x) return x.split(',')[0].trim(); }
  return req.socket.remoteAddress || '';
}
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), geolocation=(self)'
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // fallback SPA
      if (!path.extname(rel)) return serveStatic(req, res, '/');
      return fail(res, 404, 'Tidak ditemukan');
    }
    const ext = path.extname(file).toLowerCase();
    const cache = (ext === '.html' || rel === '/sw.js') ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, ...SEC_HEADERS });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- Logika bisnis ----------
const STATUS_VALID = ['hadir', 'terlambat', 'izin', 'sakit', 'alfa'];
const todayStats = (S, now) => {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM attendance WHERE tanggal=? GROUP BY status').all(now.date);
  const o = { hadir: 0, terlambat: 0, izin: 0, sakit: 0, alfa: 0 }; rows.forEach(r => o[r.status] = r.c);
  o.totalSiswa = db.prepare('SELECT COUNT(*) c FROM students WHERE aktif=1').get().c;
  return o;
};
function publicSettings(S) {
  return { jamBuka: S.jamBuka, batasTepat: S.batasTepat, jamTutup: S.jamTutup, jamTutupIzin: S.jamTutupIzin, hariAktif: S.hariAktif,
    lat: S.lat, lng: S.lng, radius: S.radius, wajibLokasi: S.wajibLokasi, wajibSelfie: S.wajibSelfie, wajibPin: S.wajibPin };
}
function savePhoto(dataUrl, nis, now) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw Object.assign(new Error('Format foto tidak valid'), { code: 400 });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 600 * 1024 || buf.length < 2000) throw Object.assign(new Error('Ukuran foto tidak valid'), { code: 400 });
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw Object.assign(new Error('File foto tidak valid'), { code: 400 });
  const dir = path.join(DATA_DIR, 'foto', now.date);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${nis.replace(/[^A-Za-z0-9_-]/g, '')}_${now.time.replace(/:/g, '')}.jpg`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `${now.date}/${name}`;
}

function studentStatusPayload(st, S, now) {
  const rec = db.prepare('SELECT status,tanggal,waktu,keterangan,jarak FROM attendance WHERE nis=? AND tanggal=?').get(st.nis, now.date) || null;
  return { ok: true, nama: st.nama, kelas: st.kelas, jk: st.jk, pinRequired: !!S.wajibPin, sudah: rec, window: windowState(S, now), now };
}

async function doAbsen(req, res) {
  const ip = clientIp(req);
  if (limited('absen:' + ip, 12)) return fail(res, 429, 'Terlalu banyak percobaan. Coba lagi sebentar.');
  const b = await readBody(req);
  const S = getSettings(); const now = wib();
  const nis = String(b.nis || '').trim();
  const st = db.prepare('SELECT * FROM students WHERE nis=? AND aktif=1').get(nis);
  if (!st) return fail(res, 404, 'NIS tidak terdaftar.');
  if (S.wajibPin && !safeEqual(b.pin || '', st.pin || '')) return fail(res, 403, 'PIN salah.');
  if (!['hadir', 'izin', 'sakit'].includes(b.status)) return fail(res, 400, 'Status tidak valid.');
  const existing = db.prepare('SELECT status,waktu FROM attendance WHERE nis=? AND tanggal=?').get(nis, now.date);
  if (existing) return fail(res, 409, `Kamu sudah absen hari ini (${existing.status}, pukul ${existing.waktu}).`);

  const w = windowState(S, now);
  if (w.state === 'libur') return fail(res, 400, 'Hari ini bukan hari belajar' + (w.libur ? ` (${w.libur})` : '') + '.');
  let finalStatus = b.status, lat = null, lng = null, akurasi = null, jarak = null;

  if (b.status === 'hadir') {
    if (w.state === 'belum') return fail(res, 400, `Absensi dibuka pukul ${S.jamBuka} WIB.`);
    if (w.state === 'tutup') return fail(res, 400, `Absensi sudah ditutup (batas ${S.jamTutup} WIB). Hubungi guru piket.`);
    if (w.state === 'terlambat') finalStatus = 'terlambat';
  } else {
    if (now.time < S.jamBuka + ':00') return fail(res, 400, `Pengajuan dibuka pukul ${S.jamBuka} WIB.`);
    if (now.time > S.jamTutupIzin + ':59') return fail(res, 400, `Pengajuan izin/sakit ditutup pukul ${S.jamTutupIzin} WIB.`);
    if (!String(b.keterangan || '').trim()) return fail(res, 400, 'Keterangan wajib diisi untuk izin/sakit.');
  }

  const hasLoc = typeof b.lat === 'number' && typeof b.lng === 'number' && Math.abs(b.lat) <= 90 && Math.abs(b.lng) <= 180;
  if (hasLoc) { lat = b.lat; lng = b.lng; akurasi = typeof b.akurasi === 'number' ? b.akurasi : null; }
  if (b.status === 'hadir' && S.wajibLokasi) {
    if (!hasLoc) return fail(res, 400, 'Lokasi GPS wajib diaktifkan untuk absen hadir.');
    if (S.lat != null && S.lng != null) {
      jarak = Math.round(haversine(lat, lng, S.lat, S.lng));
      const tol = Math.min(akurasi || 0, 50);
      if (jarak > S.radius + tol) return fail(res, 403, `Kamu berada ${jarak} m dari sekolah (batas ${S.radius} m). Absen hadir hanya bisa dari lingkungan sekolah.`, { jarak });
    }
  } else if (hasLoc && S.lat != null) jarak = Math.round(haversine(lat, lng, S.lat, S.lng));

  let foto = '';
  if (b.status === 'hadir' && S.wajibSelfie && !b.foto) return fail(res, 400, 'Foto selfie wajib diambil.');
  if (b.foto) foto = savePhoto(b.foto, nis, now);

  db.prepare('INSERT INTO attendance(nis,tanggal,waktu,status,keterangan,lat,lng,akurasi,jarak,foto,ip,ua) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(nis, now.date, now.time, finalStatus, String(b.keterangan || '').slice(0, 300), lat, lng, akurasi, jarak, foto, ip, String(req.headers['user-agent'] || '').slice(0, 200));
  send(res, 200, { ok: true, record: { nama: st.nama, kelas: st.kelas, status: finalStatus, tanggal: now.date, waktu: now.time, jarak } });
}

// ----- Rekap -----
function lastCountableDate(S, now) {
  return now.time > S.jamTutup + ':59' ? now.date : addDays(now.date, -1);
}
function dailyList(S, now, date, kelas) {
  const students = db.prepare(`SELECT * FROM students WHERE aktif=1 ${kelas ? 'AND kelas=?' : ''} ORDER BY kelas, nama`).all(...(kelas ? [kelas] : []));
  const recs = db.prepare('SELECT * FROM attendance WHERE tanggal=?').all(date);
  const map = new Map(recs.map(r => [r.nis, r]));
  const waSet = new Set(db.prepare('SELECT nis FROM wa_log WHERE tanggal=?').all(date).map(r => r.nis));
  const closed = date < now.date || (date === now.date && now.time > S.jamTutup + ':59');
  const schoolDay = isSchoolDay(S, date);
  return students.map(s => {
    const r = map.get(s.nis);
    return { nis: s.nis, nama: s.nama, kelas: s.kelas, jk: s.jk,
      status: r ? r.status : (schoolDay && closed ? 'alfa' : (schoolDay ? 'belum' : 'libur')),
      otomatis: !r, waktu: r?.waktu || '', keterangan: r?.keterangan || '', jarak: r?.jarak ?? null,
      lat: r?.lat ?? null, lng: r?.lng ?? null, foto: r?.foto || '', sumber: r?.sumber || '', hp: s.hp_ortu || '', waSent: waSet.has(s.nis) };
  });
}
function rekapRange(S, now, from, to, kelas) {
  const end = to < lastCountableDate(S, now) ? to : lastCountableDate(S, now);
  let hariEfektif = 0;
  for (let d = from, i = 0; d <= end && i < 400; d = addDays(d, 1), i++) if (isSchoolDay(S, d)) hariEfektif++;
  const students = db.prepare(`SELECT * FROM students WHERE aktif=1 ${kelas ? 'AND kelas=?' : ''} ORDER BY kelas, nama`).all(...(kelas ? [kelas] : []));
  const agg = db.prepare('SELECT nis,status,COUNT(*) c FROM attendance WHERE tanggal BETWEEN ? AND ? GROUP BY nis,status').all(from, end < from ? from : end);
  const m = new Map();
  agg.forEach(a => { if (!m.has(a.nis)) m.set(a.nis, {}); m.get(a.nis)[a.status] = a.c; });
  const rows = students.map(s => {
    const a = m.get(s.nis) || {};
    const h = a.hadir || 0, t = a.terlambat || 0, i = a.izin || 0, sk = a.sakit || 0;
    const alfa = Math.max(0, hariEfektif - (h + t + i + sk));
    return { nis: s.nis, nama: s.nama, kelas: s.kelas, hadir: h, terlambat: t, izin: i, sakit: sk, alfa,
      persen: hariEfektif ? Math.round(((h + t) / hariEfektif) * 100) : 0 };
  });
  return { hariEfektif, from, to: end < from ? from : to, rows };
}
const csvText = v => { const t = String(v ?? ''); return csvCell(/^[=+\-@\t\r]/.test(t) ? "'" + t : t); };
function rekapCsv(S, now, from, to, kelas) {
  const r = rekapRange(S, now, from, to, kelas);
  const lines = [['NIS', 'Nama', 'Kelas', 'Hadir', 'Terlambat', 'Izin', 'Sakit', 'Alfa', 'Hari Efektif', 'Persen Hadir'].join(',')];
  r.rows.forEach(x => lines.push([csvCell(x.nis), csvText(x.nama), csvText(x.kelas), x.hadir, x.terlambat, x.izin, x.sakit, x.alfa, r.hariEfektif, x.persen + '%'].join(',')));
  return '\ufeff' + lines.join('\r\n');
}
function logCsv(from, to, kelas) {
  const rows = db.prepare(`SELECT a.tanggal,a.waktu,a.nis,s.nama,s.kelas,a.status,a.keterangan,a.jarak,a.lat,a.lng,a.sumber
    FROM attendance a JOIN students s ON s.nis=a.nis WHERE a.tanggal BETWEEN ? AND ? ${kelas ? 'AND s.kelas=?' : ''} ORDER BY a.tanggal,s.kelas,s.nama`).all(...(kelas ? [from, to, kelas] : [from, to]));
  const lines = [['Tanggal', 'Waktu', 'NIS', 'Nama', 'Kelas', 'Status', 'Keterangan', 'Jarak_m', 'Latitude', 'Longitude', 'Sumber'].join(',')];
  rows.forEach(r => lines.push([r.tanggal, r.waktu, csvCell(r.nis), csvText(r.nama), csvText(r.kelas), r.status, csvText(r.keterangan), r.jarak ?? '', r.lat ?? '', r.lng ?? '', r.sumber].join(',')));
  return '\ufeff' + lines.join('\r\n');
}
function getFeedKey() {
  const r = db.prepare("SELECT v FROM kv WHERE k='feedkey'").get();
  if (r) return r.v;
  const k = crypto.randomBytes(18).toString('base64url');
  db.prepare("INSERT INTO kv(k,v) VALUES('feedkey',?)").run(k);
  return k;
}
const rangeParams = (url, now) => ({
  from: isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : now.date.slice(0, 8) + '01',
  to: isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : now.date
});
const csvCell = v => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// ---------- Laporan PDF (tanpa dependensi) ----------
const BULAN_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const PW = 841.89, PH = 595.28;
const pdfEsc = t => String(t).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
function newPage() {
  const ops = [];
  return { ops,
    t(x, y, str, size = 8, bold = false, align = 'l', w = 0) {
      const tw = String(str).length * size * 0.53; let tx = x;
      if (align === 'c') tx = x + (w - tw) / 2; else if (align === 'r') tx = x + w - tw;
      ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${tx.toFixed(2)} ${(PH - y).toFixed(2)} Td (${pdfEsc(str)}) Tj ET`);
    },
    fill(x, y, w, h, g) { ops.push(`${g} g ${x.toFixed(2)} ${(PH - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 g`); },
    line(x1, y1, x2, y2, wd = 0.5) { ops.push(`${wd} w ${x1.toFixed(2)} ${(PH - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PH - y2).toFixed(2)} l S`); }
  };
}
function assemblePdf(pages) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((pg, i) => {
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = { stream: Buffer.from(pg.ops.join('\n'), 'latin1') };
  });
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]; const offs = []; let pos = parts[0].length;
  for (let i = 1; i < objs.length; i++) {
    offs[i] = pos; const o = objs[i];
    const b = typeof o === 'string' ? Buffer.from(`${i} 0 obj\n${o}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${i} 0 obj\n<< /Length ${o.stream.length} >>\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    parts.push(b); pos += b.length;
  }
  let x = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  x += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;
  parts.push(Buffer.from(x, 'latin1'));
  return Buffer.concat(parts);
}
function buildLaporanPdf(S, now, bulan, kelas) {
  const [Y, M] = bulan.split('-').map(Number);
  const nd = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  const dates = Array.from({ length: nd }, (_, i) => `${bulan}-${String(i + 1).padStart(2, '0')}`);
  const last = lastCountableDate(S, now);
  const sd = dates.map(d => isSchoolDay(S, d));
  const countable = dates.map((d, i) => sd[i] && d <= last);
  const hariEfektif = countable.filter(Boolean).length;
  const students = db.prepare('SELECT nis,nama FROM students WHERE aktif=1 AND kelas=? ORDER BY nama').all(kelas);
  const recs = db.prepare('SELECT nis,tanggal,status FROM attendance WHERE tanggal BETWEEN ? AND ?').all(dates[0], dates[nd - 1]);
  const map = new Map(recs.map(r => [r.nis + '|' + r.tanggal, r.status]));
  const L = { hadir: 'H', terlambat: 'T', izin: 'I', sakit: 'S', alfa: 'A' };
  let sumHadir = 0;
  const rows = students.map(st => {
    const tot = { H: 0, T: 0, I: 0, S: 0, A: 0 };
    const cells = dates.map((d, i) => {
      const r = map.get(st.nis + '|' + d);
      const c = r ? L[r] : (countable[i] ? 'A' : '');
      if (c) tot[c]++;
      return c;
    });
    sumHadir += tot.H + tot.T;
    return { nama: st.nama, cells, tot };
  });
  const avg = rows.length && hariEfektif ? Math.round(sumHadir / (rows.length * hariEfektif) * 100) : 0;
  const school = getSchool();
  const wali = db.prepare('SELECT nama FROM teachers WHERE kelas=? LIMIT 1').get(kelas);

  const MX = 24, cNo = 20, cNama = 150, dW = 16, tW = 20, rowH = 14, headH = 18, top = 92;
  const xDay = MX + cNo + cNama, xTot = xDay + 31 * dW, xEnd = xTot + 5 * tW;
  const perPage = Math.floor((PH - 40 - top - headH) / rowH);
  const pages = [];
  const header = pg => {
    pg.t(0, 34, school.nama.toUpperCase(), 14, true, 'c', PW);
    pg.t(0, 50, 'REKAPITULASI KEHADIRAN SISWA', 10.5, true, 'c', PW);
    pg.t(0, 64, `Kelas ${kelas}  |  Bulan ${BULAN_ID[M - 1]} ${Y}`, 9.5, false, 'c', PW);
    pg.t(0, 76, school.alamat || '', 8, false, 'c', PW);
    pg.line(MX, 82, PW - MX, 82, 1);
  };
  const tableHead = (pg) => {
    const y = top;
    pg.fill(MX, y, xEnd - MX, headH, 0.88);
    pg.t(MX, y + 12, 'No', 7.5, true, 'c', cNo); pg.t(MX + cNo + 4, y + 12, 'Nama Siswa', 7.5, true);
    dates.forEach((d, i) => pg.t(xDay + i * dW, y + 12, String(i + 1), 6.5, true, 'c', dW));
    ['H', 'T', 'I', 'S', 'A'].forEach((k, i) => pg.t(xTot + i * tW, y + 12, k, 7.5, true, 'c', tW));
  };
  const chunks = []; for (let i = 0; i < Math.max(rows.length, 1); i += perPage) chunks.push(rows.slice(i, i + perPage));
  chunks.forEach((chunk, ci) => {
    const pg = newPage(); pages.push(pg); header(pg); tableHead(pg);
    const y0 = top + headH, yEnd = y0 + chunk.length * rowH;
    chunk.forEach((r, ri) => {
      const y = y0 + ri * rowH;
      dates.forEach((d, i) => { if (!sd[i]) pg.fill(xDay + i * dW, y, dW, rowH, 0.9); });
      pg.t(MX, y + 10, String(ci * perPage + ri + 1), 7, false, 'c', cNo);
      pg.t(MX + cNo + 4, y + 10, r.nama.length > 38 ? r.nama.slice(0, 37) + '.' : r.nama, 7);
      r.cells.forEach((c, i) => { if (c) pg.t(xDay + i * dW, y + 10, c, 7, c === 'A', 'c', dW); });
      ['H', 'T', 'I', 'S', 'A'].forEach((k, i) => pg.t(xTot + i * tW, y + 10, String(r.tot[k]), 7.5, k === 'A' && r.tot[k] > 0, 'c', tW));
    });
    for (let i = 0; i <= chunk.length + 1; i++) { const y = top + (i === 0 ? 0 : headH + (i - 1) * rowH); pg.line(MX, y, xEnd, y, 0.4); }
    const xs = [MX, MX + cNo, xDay]; for (let i = 0; i <= 31; i++) xs.push(xDay + i * dW); for (let i = 1; i <= 5; i++) xs.push(xTot + i * tW);
    xs.forEach(x => pg.line(x, top, x, yEnd, 0.4));
    pg.t(MX, PH - 18, `Halaman ${ci + 1}`, 7);
    if (ci === chunks.length - 1) { pg._yEnd = yEnd; }
  });
  // legenda + tanda tangan
  let pg = pages[pages.length - 1], y = pg._yEnd + 16;
  if (y + 120 > PH - 20) { pg = newPage(); pages.push(pg); header(pg); y = 100; }
  pg.t(MX, y, 'Keterangan: H = Hadir, T = Terlambat (tetap dihitung hadir), I = Izin, S = Sakit, A = Alfa (tanpa keterangan). Kolom abu-abu = bukan hari belajar.', 7.5);
  pg.t(MX, y + 12, `Jumlah siswa: ${rows.length}   |   Hari efektif sampai saat ini: ${hariEfektif} hari   |   Rata-rata kehadiran: ${avg}%`, 7.5, true);
  const ty = y + 34, d = now.date.split('-');
  pg.t(120, ty, 'Mengetahui,', 9); pg.t(120, ty + 12, 'Kepala Sekolah', 9);
  pg.t(PW - 300, ty, `Tumijajar, ${+d[2]} ${BULAN_ID[+d[1] - 1]} ${d[0]}`, 9); pg.t(PW - 300, ty + 12, 'Wali Kelas', 9);
  pg.t(120, ty + 62, school.kepalaSekolah || '(................................)', 9, true);
  pg.t(PW - 300, ty + 62, wali ? wali.nama : '(................................)', 9, true);
  return assemblePdf(pages);
}

// ----- Routing -----
async function handleApi(req, res, url) {
  const p = url.pathname, method = req.method;
  const S = getSettings(); const now = wib();

  // --- publik ---
  if (p === '/api/public' && method === 'GET') {
    return send(res, 200, { ok: true, now, nowMs: Date.now(), sekolah: getSchool(), settings: publicSettings(S), window: windowState(S, now),
      statistik: todayStats(S, now),
      pengumuman: db.prepare('SELECT id,judul,isi,tanggal FROM announcements ORDER BY id DESC LIMIT 10').all() });
  }
  if (p.startsWith('/api/siswa/') && method === 'GET') {
    if (limited('cek:' + clientIp(req), 40)) return fail(res, 429, 'Terlalu banyak permintaan.');
    const nis = decodeURIComponent(p.slice('/api/siswa/'.length)).trim();
    const st = db.prepare('SELECT * FROM students WHERE nis=? AND aktif=1').get(nis);
    if (!st) return fail(res, 404, 'NIS tidak terdaftar. Periksa kembali atau hubungi wali kelas.');
    return send(res, 200, studentStatusPayload(st, S, now));
  }
  if (p === '/api/absen' && method === 'POST') return doAbsen(req, res);

  // --- feed CSV untuk Google Sheets / Excel (pakai kunci rahasia) ---
  if ((p === '/api/feed/harian.csv' || p === '/api/feed/rekap.csv') && method === 'GET') {
    if (limited('feed:' + clientIp(req), 40)) return fail(res, 429, 'Terlalu banyak permintaan.');
    if (!safeEqual(url.searchParams.get('key') || '', getFeedKey())) return fail(res, 403, 'Kunci tidak valid.');
    const { from, to } = rangeParams(url, now), kelas = url.searchParams.get('kelas') || '';
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(p.includes('harian') ? logCsv(from, to, kelas) : rekapCsv(S, now, from, to, kelas));
  }

  // --- admin ---
  if (p === '/api/admin/login' && method === 'POST') {
    if (limited('login:' + clientIp(req), 6)) return fail(res, 429, 'Terlalu banyak percobaan login. Tunggu 1 menit.');
    const b = await readBody(req);
    const uname = String(b.username || '').trim().toLowerCase();
    if (uname) {
      const t = db.prepare('SELECT * FROM teachers WHERE username=?').get(uname);
      if (!t) { hashPw('dummy'); return fail(res, 401, 'Username atau password salah.'); }
      if (!checkPw(b.password || '', t.salt, t.hash)) return fail(res, 401, 'Username atau password salah.');
      return send(res, 200, { ok: true, token: makeToken({ role: 'wali', user: t.username, nama: t.nama, kelas: t.kelas }), role: 'wali', nama: t.nama, kelas: t.kelas });
    }
    if (!safeEqual(b.password || '', ADMIN_PASSWORD)) return fail(res, 401, 'Password salah.');
    return send(res, 200, { ok: true, token: makeToken({ role: 'admin', user: 'admin', nama: 'Administrator' }), role: 'admin', nama: 'Administrator', kelas: '' });
  }
  if (p.startsWith('/api/admin/')) {
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('t');
    const who = verifyToken(tok);
    if (!who) return fail(res, 401, 'Sesi berakhir. Silakan login ulang.');
    const isWali = who.role === 'wali';
    const WALI_OK = ['GET /api/admin/harian', 'GET /api/admin/rekap', 'GET /api/admin/export', 'PUT /api/admin/absen', 'DELETE /api/admin/absen', 'POST /api/admin/wa-log', 'GET /api/admin/laporan.pdf', 'GET /api/admin/export-log'];
    if (isWali && !WALI_OK.includes(method + ' ' + p)) return fail(res, 403, 'Akses ditolak untuk wali kelas.');
    const scopedKelas = q => isWali ? who.kelas : (q || '');
    const ownStudent = nis => { const st = db.prepare('SELECT nis,kelas FROM students WHERE nis=?').get(nis); return st && (!isWali || st.kelas === who.kelas) ? st : null; };

    if (p === '/api/admin/harian' && method === 'GET') {
      const date = isDate(url.searchParams.get('tanggal')) ? url.searchParams.get('tanggal') : now.date;
      const kelas = scopedKelas(url.searchParams.get('kelas'));
      const kelasList = db.prepare('SELECT DISTINCT kelas FROM students WHERE aktif=1 ORDER BY kelas').all().map(r => r.kelas).filter(k => !isWali || k === who.kelas);
      return send(res, 200, { ok: true, tanggal: date, kelasList, rows: dailyList(S, now, date, kelas), window: windowState(S, now), now, waTemplate: S.waTemplate });
    }
    if (p === '/api/admin/rekap' && method === 'GET') {
      const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : now.date.slice(0, 8) + '01';
      const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : now.date;
      const kelasList = db.prepare('SELECT DISTINCT kelas FROM students WHERE aktif=1 ORDER BY kelas').all().map(r => r.kelas).filter(k => !isWali || k === who.kelas);
      return send(res, 200, { ok: true, kelasList, ...rekapRange(S, now, from, to, scopedKelas(url.searchParams.get('kelas'))) });
    }
    if ((p === '/api/admin/export' || p === '/api/admin/export-log') && method === 'GET') {
      const { from, to } = rangeParams(url, now), kelas = scopedKelas(url.searchParams.get('kelas'));
      const isLog = p.endsWith('-log');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${isLog ? 'log' : 'rekap'}_${from}_${to}.csv"` });
      return res.end(isLog ? logCsv(from, to, kelas) : rekapCsv(S, now, from, to, kelas));
    }
    if (p === '/api/admin/feed' && method === 'GET') return send(res, 200, { ok: true, key: getFeedKey() });
    if (p === '/api/admin/feed/rotate' && method === 'POST') {
      const k = crypto.randomBytes(18).toString('base64url');
      db.prepare("INSERT INTO kv(k,v) VALUES('feedkey',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k);
      return send(res, 200, { ok: true, key: k });
    }
    if (p === '/api/admin/absen' && method === 'PUT') {
      const b = await readBody(req);
      if (!ownStudent(b.nis)) return fail(res, 404, 'Siswa tidak ditemukan di kelas Anda');
      if (!isDate(b.tanggal) || !STATUS_VALID.includes(b.status)) return fail(res, 400, 'Data tidak valid');
      db.prepare(`INSERT INTO attendance(nis,tanggal,waktu,status,keterangan,sumber) VALUES(?,?,?,?,?,'guru')
        ON CONFLICT(nis,tanggal) DO UPDATE SET status=excluded.status, keterangan=excluded.keterangan, sumber='guru'`)
        .run(b.nis, b.tanggal, wib().time, b.status, String(b.keterangan || '').slice(0, 300));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/absen' && method === 'DELETE') {
      if (!ownStudent(url.searchParams.get('nis') || '')) return fail(res, 404, 'Siswa tidak ditemukan di kelas Anda');
      db.prepare('DELETE FROM attendance WHERE nis=? AND tanggal=?').run(url.searchParams.get('nis') || '', url.searchParams.get('tanggal') || '');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/siswa' && method === 'GET') {
      return send(res, 200, { ok: true, rows: db.prepare('SELECT nis,nama,kelas,jk,pin,hp_ortu FROM students WHERE aktif=1 ORDER BY kelas,nama').all() });
    }
    if (p === '/api/admin/siswa' && method === 'POST') {
      const b = await readBody(req);
      const nis = String(b.nis || '').trim(), nama = String(b.nama || '').trim(), kelas = String(b.kelas || '').trim();
      if (!nis || !nama || !kelas) return fail(res, 400, 'NIS, nama, dan kelas wajib diisi');
      db.prepare(`INSERT INTO students(nis,nama,kelas,jk,pin,hp_ortu,aktif) VALUES(?,?,?,?,?,?,1)
        ON CONFLICT(nis) DO UPDATE SET nama=excluded.nama,kelas=excluded.kelas,jk=excluded.jk,pin=excluded.pin,hp_ortu=excluded.hp_ortu,aktif=1`)
        .run(nis, nama, kelas, String(b.jk || '').toUpperCase().slice(0, 1), String(b.pin || ''), normHp(b.hp));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/siswa/import' && method === 'POST') {
      const b = await readBody(req, 4 * 1024 * 1024);
      const lines = String(b.csv || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const ins = db.prepare(`INSERT INTO students(nis,nama,kelas,jk,pin,hp_ortu,aktif) VALUES(?,?,?,?,?,?,1)
        ON CONFLICT(nis) DO UPDATE SET nama=excluded.nama,kelas=excluded.kelas,jk=excluded.jk,pin=excluded.pin,hp_ortu=excluded.hp_ortu,aktif=1`);
      let n = 0, skip = 0;
      db.exec('BEGIN');
      try {
        lines.forEach((l, i) => {
          const c = l.split(/[;,\t]/).map(x => x.trim().replace(/^"|"$/g, ''));
          if (i === 0 && /nis/i.test(c[0])) return;
          if (!c[0] || !c[1] || !c[2]) { skip++; return; }
          ins.run(c[0], c[1], c[2], (c[3] || '').toUpperCase().slice(0, 1), c[4] || '', normHp(c[5])); n++;
        });
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return send(res, 200, { ok: true, diimpor: n, dilewati: skip });
    }
    if (p.startsWith('/api/admin/siswa/') && method === 'DELETE') {
      db.prepare('UPDATE students SET aktif=0 WHERE nis=?').run(decodeURIComponent(p.split('/').pop()));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/settings' && method === 'GET') return send(res, 200, { ok: true, settings: S });
    if (p === '/api/admin/settings' && method === 'PUT') {
      const b = await readBody(req);
      const n = { ...S };
      for (const k of ['jamBuka', 'batasTepat', 'jamTutup', 'jamTutupIzin']) if (b[k] !== undefined) { if (!isHM(b[k])) return fail(res, 400, `Format jam ${k} tidak valid`); n[k] = b[k]; }
      if (!(n.jamBuka <= n.batasTepat && n.batasTepat <= n.jamTutup)) return fail(res, 400, 'Urutan jam harus: buka ≤ batas tepat waktu ≤ tutup.');
      if (Array.isArray(b.hariAktif)) n.hariAktif = b.hariAktif.map(Number).filter(x => x >= 0 && x <= 6);
      for (const k of ['wajibLokasi', 'wajibSelfie', 'wajibPin']) if (b[k] !== undefined) n[k] = !!b[k];
      if (b.lat !== undefined) n.lat = b.lat === null || b.lat === '' ? null : Number(b.lat);
      if (b.lng !== undefined) n.lng = b.lng === null || b.lng === '' ? null : Number(b.lng);
      if ((n.lat != null && (isNaN(n.lat) || Math.abs(n.lat) > 90)) || (n.lng != null && (isNaN(n.lng) || Math.abs(n.lng) > 180))) return fail(res, 400, 'Koordinat tidak valid');
      if (typeof b.waTemplate === 'string' && b.waTemplate.trim()) n.waTemplate = b.waTemplate.slice(0, 600);
      if (b.radius !== undefined) n.radius = Math.min(5000, Math.max(20, Number(b.radius) || 150));
      if (Array.isArray(b.libur)) n.libur = b.libur.filter(l => isDate(l.tanggal)).map(l => ({ tanggal: l.tanggal, ket: String(l.ket || '').slice(0, 80) }));
      saveSettings(n);
      return send(res, 200, { ok: true, settings: n });
    }
    if (p === '/api/admin/guru' && method === 'GET') {
      return send(res, 200, { ok: true, rows: db.prepare('SELECT username,nama,kelas FROM teachers ORDER BY kelas').all(), kelasList: db.prepare('SELECT DISTINCT kelas FROM students WHERE aktif=1 ORDER BY kelas').all().map(r => r.kelas) });
    }
    if (p === '/api/admin/guru' && method === 'POST') {
      const b = await readBody(req);
      const u = String(b.username || '').trim().toLowerCase(), nama = String(b.nama || '').trim(), kelas = String(b.kelas || '').trim();
      if (!/^[a-z0-9._-]{3,30}$/.test(u)) return fail(res, 400, 'Username 3-30 karakter (huruf kecil, angka, titik, strip).');
      if (!nama || !kelas) return fail(res, 400, 'Nama dan kelas wajib diisi');
      const exists = db.prepare('SELECT 1 FROM teachers WHERE username=?').get(u);
      if (!exists && String(b.password || '').length < 6) return fail(res, 400, 'Password minimal 6 karakter');
      if (exists && !b.password) db.prepare('UPDATE teachers SET nama=?,kelas=? WHERE username=?').run(nama, kelas, u);
      else { if (String(b.password).length < 6) return fail(res, 400, 'Password minimal 6 karakter'); const h = hashPw(b.password);
        db.prepare('INSERT INTO teachers(username,nama,kelas,salt,hash) VALUES(?,?,?,?,?) ON CONFLICT(username) DO UPDATE SET nama=excluded.nama,kelas=excluded.kelas,salt=excluded.salt,hash=excluded.hash').run(u, nama, kelas, h.salt, h.hash); }
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/admin/guru/') && method === 'DELETE') {
      db.prepare('DELETE FROM teachers WHERE username=?').run(decodeURIComponent(p.split('/').pop()));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/wa-log' && method === 'POST') {
      const b = await readBody(req);
      if (!ownStudent(b.nis) || !isDate(b.tanggal)) return fail(res, 404, 'Siswa tidak ditemukan di kelas Anda');
      db.prepare('INSERT OR REPLACE INTO wa_log(nis,tanggal,waktu,oleh) VALUES(?,?,?,?)').run(b.nis, b.tanggal, now.time, who.user);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/laporan.pdf' && method === 'GET') {
      const q = url.searchParams.get('bulan') || '';
      const bulan = /^\d{4}-(0[1-9]|1[0-2])$/.test(q) ? q : now.date.slice(0, 7);
      const kelas = scopedKelas(url.searchParams.get('kelas'));
      if (!kelas) return fail(res, 400, 'Pilih kelas terlebih dahulu.');
      const pdf = buildLaporanPdf(S, now, bulan, kelas);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="laporan_${kelas.replace(/[^A-Za-z0-9]+/g, '_')}_${bulan}.pdf"`, 'Cache-Control': 'no-store' });
      return res.end(pdf);
    }
    if (p === '/api/admin/pengumuman' && method === 'POST') {
      const b = await readBody(req);
      if (!String(b.judul || '').trim() || !String(b.isi || '').trim()) return fail(res, 400, 'Judul dan isi wajib diisi');
      db.prepare('INSERT INTO announcements(judul,isi,tanggal) VALUES(?,?,?)').run(String(b.judul).slice(0, 120), String(b.isi).slice(0, 1000), now.date);
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/api/admin/pengumuman/') && method === 'DELETE') {
      db.prepare('DELETE FROM announcements WHERE id=?').run(Number(p.split('/').pop()));
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, 'Endpoint tidak ditemukan');
  }
  return fail(res, 404, 'Endpoint tidak ditemukan');
}

function serveFoto(req, res, url) {
  const tok = url.searchParams.get('t') || (req.headers.authorization || '').replace(/^Bearer /, '');
  const who = verifyToken(tok);
  if (!who) return fail(res, 401, 'Tidak diizinkan');
  const rel = decodeURIComponent(url.pathname.slice('/foto/'.length));
  if (!/^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]+\.jpg$/.test(rel)) return fail(res, 400, 'Nama file tidak valid');
  if (who.role === 'wali') {
    const st = db.prepare('SELECT kelas FROM students WHERE nis=?').get(rel.split('/')[1].split('_')[0]);
    if (!st || st.kelas !== who.kelas) return fail(res, 403, 'Akses ditolak');
  }
  const f = path.join(DATA_DIR, 'foto', rel);
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) return fail(res, 404, 'Foto tidak ada');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=600' });
    fs.createReadStream(f).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/foto/')) return serveFoto(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method tidak diizinkan');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e.code === 413 || e.code === 400) return fail(res, e.code, e.message);
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Terjadi kesalahan pada server');
  }
});
server.listen(PORT, HOST, () => console.log(`Absensi SMAN 1 Tumijajar berjalan di http://${HOST}:${PORT}  (zona waktu ${TZ})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); try { db.close(); } catch {} process.exit(0); });
