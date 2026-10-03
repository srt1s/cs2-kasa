const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Railway'de kalıcı veri için Volume bağlayıp DATA_DIR=/data verin.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'data.json');

const KEY_PRICE = 2.5;          // 1 anahtar = 2.50 para
const START_KEYS = 5;
const GIVEAWAY_MS = 5 * 60 * 1000;
const GIVEAWAY_PRIZE_KEYS = 5;

const RARITIES = {
  mil:   { name: 'Mil-Spec',   color: '#4b69ff', weight: 79.92 },
  rest:  { name: 'Restricted', color: '#8847ff', weight: 15.98 },
  class: { name: 'Classified', color: '#d32ce6', weight: 3.2 },
  cov:   { name: 'Covert',     color: '#eb4b4b', weight: 0.64 },
  gold:  { name: 'Rare Special', color: '#ffd700', weight: 0.26 },
};
const SKINS = [
  ['mil', 'MP9 | Hydra', 0.6], ['mil', 'Nova | Sobek', 0.5], ['mil', 'P250 | Sand Dune', 0.4],
  ['mil', 'SSG 08 | Dragonfire', 0.8], ['mil', 'Glock-18 | Candy Apple', 0.7],
  ['rest', 'AK-47 | Slate', 3.5], ['rest', 'M4A4 | Desert-Strike', 4.2], ['rest', 'USP-S | Cortex', 5.0],
  ['rest', 'AWP | Atheris', 4.5],
  ['class', 'AK-47 | Redline', 18], ['class', 'M4A1-S | Hyper Beast', 22], ['class', 'AWP | Asiimov', 35],
  ['cov', 'AK-47 | Fire Serpent', 220], ['cov', 'AWP | Dragon Lore', 600],
  ['gold', 'Karambit | Doppler', 900], ['gold', 'Butterfly Knife | Fade', 1500],
].map(([r, name, price], i) => ({ id: i, rarity: r, name, price }));

let db = { users: {}, giveaway: { next: Date.now() + GIVEAWAY_MS, entrants: [], last: null } };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
const save = () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error(e.message); } };
const sessions = {}; // token -> username

function hash(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }
function rollSkin() {
  let r = Math.random() * 100, rar = 'mil';
  for (const k of Object.keys(RARITIES)) { if ((r -= RARITIES[k].weight) < 0) { rar = k; break; } }
  const pool = SKINS.filter(s => s.rarity === rar);
  return pool[Math.floor(Math.random() * pool.length)];
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const u = sessions[req.headers['x-token']];
  if (!u || !db.users[u]) return res.status(401).json({ error: 'Giriş yap' });
  req.user = db.users[u]; next();
}
const pub = u => ({ name: u.name, keys: u.keys, money: +u.money.toFixed(2), inventory: u.inventory });

app.get('/api/info', (_, res) => res.json({ skins: SKINS, rarities: RARITIES, keyPrice: KEY_PRICE }));

app.post('/api/login', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 16);
  const pw = String(req.body.password || '');
  if (!/^[\w\-ğüşıöçĞÜŞİÖÇ]{3,16}$/.test(name) || pw.length < 4)
    return res.status(400).json({ error: 'Kullanıcı adı 3-16 karakter, şifre en az 4 karakter' });
  const key = name.toLowerCase();
  let u = db.users[key];
  if (!u) {
    const salt = crypto.randomBytes(8).toString('hex');
    u = db.users[key] = { name, salt, pw: hash(pw, salt), keys: START_KEYS, money: 0, inventory: [], nextId: 1 };
    save();
  } else if (hash(pw, u.salt) !== u.pw) return res.status(403).json({ error: 'Şifre yanlış' });
  const token = crypto.randomBytes(16).toString('hex');
  sessions[token] = key;
  res.json({ token, me: pub(u) });
});

app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));

app.post('/api/open', auth, (req, res) => {
  const u = req.user;
  if (u.keys < 1) return res.status(400).json({ error: 'Anahtarın yok' });
  u.keys -= 1;
  const skin = rollSkin();
  const item = { uid: u.nextId++, ...skin };
  u.inventory.push(item);
  save();
  res.json({ item, me: pub(u) });
});

app.post('/api/sell', auth, (req, res) => {
  const u = req.user;
  const { uid, all } = req.body;
  const sold = all ? u.inventory : u.inventory.filter(i => i.uid === uid);
  if (!sold.length) return res.status(400).json({ error: 'Eşya yok' });
  u.money += sold.reduce((a, i) => a + i.price, 0);
  u.inventory = all ? [] : u.inventory.filter(i => i.uid !== uid);
  save();
  res.json(pub(u));
});

app.post('/api/buykeys', auth, (req, res) => {
  const u = req.user;
  const n = Math.floor(Number(req.body.count));
  if (!(n >= 1 && n <= 10000)) return res.status(400).json({ error: 'Geçersiz miktar' });
  const cost = n * KEY_PRICE;
  if (u.money + 1e-9 < cost) return res.status(400).json({ error: 'Yetersiz para' });
  u.money -= cost; u.keys += n; save();
  res.json(pub(u));
});

// Çekiliş
app.get('/api/giveaway', (req, res) => {
  const u = sessions[req.headers['x-token']];
  res.json({
    next: db.giveaway.next, now: Date.now(), prize: GIVEAWAY_PRIZE_KEYS,
    count: db.giveaway.entrants.length, last: db.giveaway.last,
    joined: !!u && db.giveaway.entrants.includes(u),
  });
});
app.post('/api/giveaway/join', auth, (req, res) => {
  const key = req.user.name.toLowerCase();
  if (!db.giveaway.entrants.includes(key)) { db.giveaway.entrants.push(key); save(); }
  res.json({ ok: true });
});
function draw() {
  const g = db.giveaway;
  if (g.entrants.length) {
    const key = g.entrants[Math.floor(Math.random() * g.entrants.length)];
    const u = db.users[key];
    if (u) { u.keys += GIVEAWAY_PRIZE_KEYS; g.last = { winner: u.name, prize: GIVEAWAY_PRIZE_KEYS, players: g.entrants.length, at: Date.now() }; }
  } else g.last = { winner: null, at: Date.now(), players: 0 };
  g.entrants = [];
  g.next = Date.now() + GIVEAWAY_MS;
  save();
}
setInterval(() => { if (Date.now() >= db.giveaway.next) draw(); }, 1000);

app.listen(PORT, () => console.log('Sunucu çalışıyor: ' + PORT));
