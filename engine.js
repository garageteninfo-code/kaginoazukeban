// 鍵の預け番：仕組み（ブラウザでもそのまま動く普通の JS。node でも require できる）。
//
// 何をするか:
//   1) 「もしもの時のメモ」を、使い捨ての鍵（32 バイトの乱数）で AES-GCM により封をする（＝封筒）。
//   2) その鍵を Shamir の秘密分散（GF(256)）で n 枚のカードに分け、k 枚そろえば鍵に戻せるようにする。
//      カードの形は 以前に作った社内の「紙の復旧コード」v1と 1 バイトも違わない
//      （試験/engine.test.mjs が元の TS の写し 試験/参照/rootKeyPaperCodes.ts と突き合わせる）。
//   3) 封筒は人が打ち直せる文字（Crockford の 32 進）にし、1 行 20 文字ごとに 2 文字の検査（CRC-10）を付ける。
//      1 文字の書き違い・隣どうしの入れ替わりは、その行で必ず見つかる（試験で全部の場所を確かめる）。
//   4) 作った・点検した・開けたを、ハッシュでつないだ記録（以前に作った社内の監査の鎖の考え方）に残す。
//      最初の行の指紋の頭（記録の印）をカードに印刷するので、作った時の記録を後から書き換えると分かる。
//
// 正直に書いておくこと（約束を盛らない）:
//   ・k-1 枚以下のカードからは、鍵について何も分からない（Shamir の性質）。ただしカードには
//     「組の印」と「鍵の指紋の頭（24 ビット）」が平文で入っている。鍵は 256 ビットの乱数なので、総当たりの助けにはならない。
//   ・k 枚を集めた人は封筒を開けられる。だからカードは別々の人・場所に預ける。紙そのものを守る仕組みではない。
//   ・記録のハッシュの鎖は「途中の 1 行を書き換えた」ことは分かるが、ファイルを持つ人が全部を作り直すと、
//     最初の行（カードに印刷した印）より後ろは見分けられない。最新の印を紙に書き写しておくと、そこまでは守れる。
//   ・通信はしない。乱数と暗号はブラウザ（または node）の Web Crypto を使う。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AzukeEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WC = globalThis.crypto;
  const subtle = WC && WC.subtle;
  const defaultRand = (n) => { const b = new Uint8Array(n); WC.getRandomValues(b); return b; };

  // ===== GF(256)（AES と同じ既約多項式 0x11b・生成元 3。元の TS と同じ表）=====
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      const x2 = ((x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff;
      x = x ^ x2;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gfMul(a, b) { return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]; }
  function gfDiv(a, b) {
    if (b === 0) throw new Error('GF(256): 0 で割ろうとしました');
    return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
  }
  function evalPoly(coeffs, x) {
    let y = 0;
    for (let i = coeffs.length - 1; i >= 0; i--) y = gfMul(y, x) ^ coeffs[i];
    return y;
  }

  /** 秘密を n 個に分ける（x=1..n の y の列）。k 個で戻る。 */
  function shamirSplit(secret, n, k, rand = defaultRand) {
    if (!Number.isInteger(n) || !Number.isInteger(k) || k < 2 || n < k || n > 255) throw new Error('shamirSplit: k と n が正しくありません');
    const ys = Array.from({ length: n }, () => new Uint8Array(secret.length));
    const coeffs = new Uint8Array(k);
    for (let i = 0; i < secret.length; i++) {
      coeffs[0] = secret[i];
      const r = rand(k - 1);
      if (r.length !== k - 1) throw new Error('shamirSplit: 乱数の長さが違います');
      coeffs.set(r, 1);
      for (let j = 0; j < n; j++) ys[j][i] = evalPoly(coeffs, j + 1);
    }
    coeffs.fill(0);
    return ys;
  }

  /** 点の組から x=0 の値（秘密）を戻す（Lagrange）。 */
  function shamirCombine(points) {
    if (points.length === 0) throw new Error('shamirCombine: 点がありません');
    const len = points[0].y.length;
    const out = new Uint8Array(len);
    for (let j = 0; j < points.length; j++) {
      let num = 1, den = 1;
      for (let m = 0; m < points.length; m++) {
        if (m === j) continue;
        num = gfMul(num, points[m].x);
        den = gfMul(den, points[m].x ^ points[j].x);
      }
      const l = gfDiv(num, den);
      const yj = points[j].y;
      for (let i = 0; i < len; i++) out[i] ^= gfMul(yj[i], l);
    }
    return out;
  }

  // ===== 検査 =====
  /** CRC-16/CCITT-FALSE（カードの検査。元の TS と同じ）。 */
  function crc16(bytes) {
    let crc = 0xffff;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }
  /**
   * CRC-10（x^10+x^9+x^5+x^4+x+1）を、ビットの列にかける（封筒の行の検査）。
   * 10 ビット以下にまとまった誤りは全部見つかる＝1 文字（5 ビット）の書き違い・隣どうしの入れ替わり（10 ビット）は必ず見つかる。
   */
  function crc10Bits(feed) {
    let crc = 0x3ff;
    feed((bit) => {
      const top = ((crc >> 9) & 1) ^ bit;
      crc = (crc << 1) & 0x3ff;
      if (top) crc ^= 0x233;
    });
    return crc;
  }

  // ===== Crockford の 32 進（I L O U を使わない＝書き写しで紛れにくい）=====
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function toBase32(bytes) {
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
      value = (value << 8) | b; bits += 8;
      while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
      value &= (1 << bits) - 1;
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
  }
  function fromBase32(s) {
    const out = new Uint8Array(Math.floor((s.length * 5) / 8));
    let bits = 0, value = 0, o = 0;
    for (const ch of s) {
      const v = ALPHABET.indexOf(ch);
      if (v < 0) return null;
      value = (value << 5) | v; bits += 5;
      if (bits >= 8) { out[o++] = (value >>> (bits - 8)) & 0xff; bits -= 8; value &= (1 << bits) - 1; }
    }
    return out;
  }
  /** 書き写した文字をそろえる。全角→半角、小文字→大文字、O→0、I/L→1、区切り（- と空白など）は捨てる。 */
  function normalizeCode(raw) {
    return String(raw == null ? '' : raw).normalize('NFKC').toUpperCase()
      .replace(/[\s\-‐-―ー－_.・,、。]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  }
  function groupCode(s) { return (s.match(/.{1,4}/g) || []).join('-'); }

  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const unhex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
  async function sha256(bytes) { return new Uint8Array(await subtle.digest('SHA-256', bytes)); }
  const utf8 = (s) => new TextEncoder().encode(s);
  const fromUtf8 = (b) => new TextDecoder('utf-8', { fatal: true }).decode(b);

  // ===== カード（以前に作った社内の紙の復旧コード v1 と同じ形：40 バイト＝64 文字）=====
  //   [0] 上 4 ビット＝版（1）・下 4 ビット＝k   [1] 上 4 ビット＝枚の番号 x・下 4 ビット＝n
  //   [2] 組の印（作るたびの乱数）  [3..5] 鍵の指紋の頭（sha256(鍵) の頭 3 バイト）
  //   [6..37] 分けた値（32 バイト）  [38..39] CRC-16
  const KEY_BYTES = 32, CARD_BYTES = 40, CARD_CHARS = 64, MIN_N = 2, MAX_N = 9;

  function encodeCard(c) {
    if (c.y.length !== KEY_BYTES) throw new Error('encodeCard: 値の長さが違います');
    const body = new Uint8Array(CARD_BYTES);
    body[0] = (1 << 4) | c.k;
    body[1] = (c.x << 4) | c.n;
    body[2] = c.setId & 0xff;
    body.set(unhex(c.fpHead).subarray(0, 3), 3);
    body.set(c.y, 6);
    const crc = crc16(body.subarray(0, 38));
    body[38] = crc >> 8; body[39] = crc & 0xff;
    return groupCode(toBase32(body));
  }

  /** カード 1 枚を読む。失敗は code：EMPTY・CHAR・LENGTH・TYPO・VERSION・FIELDS。 */
  function parseCard(raw) {
    const s = normalizeCode(raw);
    if (s.length === 0) return { ok: false, code: 'EMPTY' };
    const bad = [...s].find((ch) => !ALPHABET.includes(ch));
    if (bad) return { ok: false, code: 'CHAR', char: bad };
    if (s.length !== CARD_CHARS) return { ok: false, code: 'LENGTH', got: s.length };
    const b = fromBase32(s);
    if (crc16(b.subarray(0, 38)) !== ((b[38] << 8) | b[39])) return { ok: false, code: 'TYPO' };
    const version = b[0] >> 4, k = b[0] & 15, x = b[1] >> 4, n = b[1] & 15;
    if (version !== 1) return { ok: false, code: 'VERSION', version };
    if (k < MIN_N || n > MAX_N || k > n || x < 1 || x > n) return { ok: false, code: 'FIELDS' };
    return { ok: true, card: { k, n, x, setId: b[2], fpHead: hex(b.subarray(3, 6)), y: b.slice(6, 38) } };
  }

  /** 組の印（画面とカードに出す。秘密ではない）。例：「3F-A1B2C3」 */
  function setMark(setId, fpHead) { return setId.toString(16).padStart(2, '0').toUpperCase() + '-' + fpHead.toUpperCase(); }

  async function makeCards(key, n, k, rand = defaultRand) {
    if (key.length !== KEY_BYTES) throw new Error('鍵は 32 バイトです');
    if (!Number.isInteger(n) || n < MIN_N || n > MAX_N) throw new Error(`預ける人数は ${MIN_N}〜${MAX_N} 人です`);
    if (!Number.isInteger(k) || k < MIN_N || k > n) throw new Error(`開けるのに要る枚数は ${MIN_N}〜${n} 枚です`);
    const setId = rand(1)[0];
    const fpHead = hex(await sha256(key)).slice(0, 6);
    const ys = shamirSplit(key, n, k, rand);
    const codes = ys.map((y, i) => encodeCard({ k, n, x: i + 1, setId, fpHead, y }));
    for (const y of ys) y.fill(0);
    return { codes, n, k, setId, fpHead };
  }

  /** カード（入れた順）から鍵を戻す。空の欄は数えない。失敗は元の TS と同じ code。 */
  async function combineCards(rawCodes) {
    const items = (rawCodes || []).map((c, i) => ({ raw: String(c == null ? '' : c), index: i + 1 }))
      .filter((c) => normalizeCode(c.raw).length > 0);
    if (items.length === 0) return { ok: false, code: 'NONE' };
    const cards = [];
    for (const it of items) {
      const p = parseCard(it.raw);
      if (!p.ok) return { ok: false, code: 'PARSE', index: it.index, reason: p };
      cards.push(Object.assign({ index: it.index }, p.card));
    }
    const first = cards[0];
    for (const c of cards.slice(1)) {
      if (c.fpHead !== first.fpHead) return { ok: false, code: 'MIXED_KEY', index: c.index };
      if (c.setId !== first.setId || c.k !== first.k || c.n !== first.n) return { ok: false, code: 'MIXED_SET', index: c.index };
    }
    const seen = new Set();
    for (const c of cards) {
      if (seen.has(c.x)) return { ok: false, code: 'DUPLICATE', x: c.x };
      seen.add(c.x);
    }
    if (cards.length < first.k) return { ok: false, code: 'NOT_ENOUGH', need: first.k, have: cards.length };
    const key = shamirCombine(cards.map((c) => ({ x: c.x, y: c.y })));
    if (hex(await sha256(key)).slice(0, 6) !== first.fpHead) { key.fill(0); return { ok: false, code: 'BAD_RESULT' }; }
    return { ok: true, key, k: first.k, n: first.n, setId: first.setId, fpHead: first.fpHead, used: cards.map((c) => c.x) };
  }

  // ===== 封筒（メモを封をした物）=====
  //   [0] 0xA5  [1] 版（1）  [2] 組の印  [3..5] 鍵の指紋の頭  [6..17] iv（12 バイト）  [18..] 暗号文＋検査（16 バイト）
  //   AES-GCM の追加データ＝[0..17]（見出しを書き換えると開かない）
  const ENV_MAGIC = 0xa5, ENV_VERSION = 1, ENV_HEAD = 18, MEMO_MAX_BYTES = 2000, LINE_CHARS = 20;

  async function importKey(key) { return subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }

  async function sealMemo(key, setId, fpHead, memo, rand = defaultRand) {
    const plain = utf8(JSON.stringify({ v: 1, company: String(memo.company || ''), text: String(memo.text || ''), created: String(memo.created || '') }));
    if (plain.length > MEMO_MAX_BYTES + 200) throw new Error('メモが長すぎます');
    const head = new Uint8Array(ENV_HEAD);
    head[0] = ENV_MAGIC; head[1] = ENV_VERSION; head[2] = setId & 0xff;
    head.set(unhex(fpHead).subarray(0, 3), 3);
    head.set(rand(12), 6);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: head.subarray(6, 18), additionalData: head }, await importKey(key), plain));
    plain.fill(0);
    const out = new Uint8Array(ENV_HEAD + ct.length);
    out.set(head, 0); out.set(ct, ENV_HEAD);
    return out;
  }

  /** 封筒の見出しだけ読む（鍵なしでわかる所）。 */
  function envelopeHead(env) {
    if (!env || env.length < ENV_HEAD + 16 || env[0] !== ENV_MAGIC) return null;
    return { version: env[1], setId: env[2], fpHead: hex(env.subarray(3, 6)) };
  }

  async function openMemo(key, env) {
    const h = envelopeHead(env);
    if (!h || h.version !== ENV_VERSION) return { ok: false, code: 'NOT_ENVELOPE' };
    const fp = hex(await sha256(key)).slice(0, 6);
    if (fp !== h.fpHead) return { ok: false, code: 'WRONG_SET' };
    try {
      const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: env.subarray(6, 18), additionalData: env.subarray(0, ENV_HEAD) }, await importKey(key), env.subarray(ENV_HEAD)));
      const memo = JSON.parse(fromUtf8(plain));
      plain.fill(0);
      return { ok: true, memo };
    } catch (_e) {
      return { ok: false, code: 'BROKEN' };
    }
  }

  function lineCheck(lineNo, total, chars) {
    const c = crc10Bits((put) => {
      for (const v of [lineNo & 0xff, total & 0xff]) for (let i = 7; i >= 0; i--) put((v >> i) & 1);
      for (const ch of chars) { const v = ALPHABET.indexOf(ch); for (let i = 4; i >= 0; i--) put((v >> i) & 1); }
    });
    return ALPHABET[c >> 5] + ALPHABET[c & 31];
  }

  /** 封筒を、人が打ち直せる行にする。例：「01: ABCD EFGH JKMN PQRS TVWX / K7」 */
  function envelopeToLines(env) {
    const s = toBase32(env);
    const parts = s.match(new RegExp(`.{1,${LINE_CHARS}}`, 'g')) || [];
    if (parts.length > 255) throw new Error('封筒が長すぎます');
    return parts.map((p, i) => `${String(i + 1).padStart(2, '0')}: ${(p.match(/.{1,4}/g) || []).join(' ')} / ${lineCheck(i + 1, parts.length, p)}`);
  }

  /**
   * 打ち直した（または貼り付けた）封筒の行を読む。
   * 失敗は code：EMPTY・LINE_FORMAT（行の形が違う）・LINE_TYPO（その行の書き写しが違う）・LINE_MISSING・LINE_DUP・CHAR。
   */
  function parseEnvelopeText(text) {
    let t = String(text == null ? '' : text);
    if (t.includes(FILE_HEAD)) {                                // ファイルを丸ごと貼った時は、封筒の所だけ読む
      const b = parseBundle(t);
      if (!b.ok) return { ok: false, code: 'NOT_ENVELOPE' };
      t = b.envelopeText;
    }
    const lines = t.normalize('NFKC').split(/\r?\n/);
    const got = new Map();
    let total = null, any = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || !/^[0-9]/.test(raw)) continue;             // 見出し・説明の行は読み飛ばす
      any = true;
      const m = raw.match(/^(\d{1,3})\s*[:：]\s*(.+?)\s*[\/／]\s*(\S+)\s*$/);
      if (!m) return { ok: false, code: 'LINE_FORMAT', line: Number(raw.match(/^\d+/)[0]) };
      const no = Number(m[1]);
      const body = normalizeCode(m[2]);
      const chk = normalizeCode(m[3]);
      const bad = [...body + chk].find((ch) => !ALPHABET.includes(ch));
      if (bad) return { ok: false, code: 'CHAR', line: no, char: bad };
      if (got.has(no)) return { ok: false, code: 'LINE_DUP', line: no };
      got.set(no, { body, chk });
    }
    if (!any) return { ok: false, code: 'EMPTY' };
    // 行の数は、どの行の検査にも入っている。最後の行の番号を候補にして、全部の行で確かめる。
    const maxNo = Math.max(...got.keys());
    total = maxNo;
    const okWith = (no, v, t) => v.chk.length === 2 && lineCheck(no, t, v.body) === v.chk;
    const sorted = [...got].sort((a, b) => a[0] - b[0]);
    const failing = sorted.filter(([no, v]) => !okWith(no, v, total));
    if (failing.length === sorted.length && sorted.length > 1) {
      // どの行も合わない＝最後の行（いくつか）が欠けている見込み。全部の行が合う行の数を探す。
      for (let t = maxNo + 1; t <= 255; t++) {
        if (sorted.every(([no, v]) => okWith(no, v, t))) return { ok: false, code: 'LINE_MISSING', line: maxNo + 1, total: t };
      }
    }
    if (failing.length) return { ok: false, code: 'LINE_TYPO', line: failing[0][0] };
    for (let no = 1; no <= total; no++) if (!got.has(no)) return { ok: false, code: 'LINE_MISSING', line: no, total };
    const bodies = [];
    for (let no = 1; no <= total; no++) {
      const b = got.get(no).body;
      if (no < total && b.length !== LINE_CHARS) return { ok: false, code: 'LINE_TYPO', line: no };
      bodies.push(b);
    }
    const bytes = fromBase32(bodies.join(''));
    if (!bytes || !envelopeHead(bytes)) return { ok: false, code: 'NOT_ENVELOPE' };
    return { ok: true, bytes, lines: total };
  }

  // ===== 記録（ハッシュでつないだ帳面）=====
  function canonicalJson(value) {
    const norm = (v) => {
      if (v === null || typeof v !== 'object') return typeof v === 'number' && Object.is(v, -0) ? 0 : v;
      if (Array.isArray(v)) return v.map(norm);
      const out = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = norm(v[k]);
      return out;
    };
    return JSON.stringify(norm(value));
  }
  const GENESIS_PREV = '0'.repeat(64);
  async function entryHash(e) {
    return hex(await sha256(utf8(canonicalJson({ i: e.i, at: e.at, kind: e.kind, who: e.who, note: e.note, data: e.data, prev: e.prev }))));
  }
  /** 記録に 1 行足す（元の配列は変えず、新しい配列を返す）。 */
  async function appendLog(log, { at, kind, who = '', note = '', data = null }) {
    const prev = log.length ? log[log.length - 1].hash : GENESIS_PREV;
    const e = { i: log.length + 1, at: String(at), kind: String(kind), who: String(who), note: String(note), data, prev };
    e.hash = await entryHash(e);
    return log.concat([e]);
  }
  /** 印（指紋の頭 8 桁を 4-4 に）。 */
  function markOf(hash) { return (hash || '').slice(0, 8).toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2'); }

  /**
   * 記録を確かめる。anchor（カードに印刷した記録の印）を渡すと、最初の行もそれと比べる。
   * 失敗は code：EMPTY・NUMBER（番号が飛ぶ・入れ替わり）・LINK（前の行とつながらない＝前の行が消えた・入れ替わった）・
   *              EDITED（その行の中身が書き換わった）・FIRST（最初の行が「作成」でない）・ANCHOR（カードの印と合わない）
   */
  async function verifyLog(log, anchor) {
    if (!Array.isArray(log) || log.length === 0) return { ok: false, code: 'EMPTY' };
    let prev = GENESIS_PREV;
    for (let j = 0; j < log.length; j++) {
      const e = log[j];
      if (e.i !== j + 1) return { ok: false, code: 'NUMBER', line: j + 1 };
      if (e.prev !== prev) return { ok: false, code: 'LINK', line: j + 1 };
      if ((await entryHash(e)) !== e.hash) return { ok: false, code: 'EDITED', line: j + 1 };
      prev = e.hash;
    }
    if (log[0].kind !== '作成') return { ok: false, code: 'FIRST', line: 1 };
    if (anchor && normalizeCode(anchor) !== normalizeCode(markOf(log[0].hash))) return { ok: false, code: 'ANCHOR', line: 1 };
    return { ok: true, lines: log.length, anchor: markOf(log[0].hash), latest: markOf(log[log.length - 1].hash) };
  }

  // ===== 1 つのファイル（封筒＋記録）=====
  const FILE_HEAD = '=== 鍵の預け番 v1 ===';
  const ENV_SECTION = '--- 封筒（k 枚のカードがそろわないと読めません） ---';
  const LOG_SECTION = '--- 記録（1 行ずつ前の行とつながっています。書き換えないでください） ---';

  function bundleToText({ title, envelopeLines, log }) {
    return [FILE_HEAD, String(title || ''), '', ENV_SECTION, ...envelopeLines, '', LOG_SECTION, ...log.map((e) => JSON.stringify(e)), ''].join('\n');
  }
  /** ファイルを読む。封筒の行の文字と、記録の配列を返す（記録は確かめずに返す。verifyLog で確かめる）。 */
  function parseBundle(text) {
    const t = String(text == null ? '' : text).replace(/^﻿/, '');
    if (!t.includes(FILE_HEAD)) return { ok: false, code: 'NOT_BUNDLE' };
    const envAt = t.indexOf(ENV_SECTION), logAt = t.indexOf(LOG_SECTION);
    if (envAt < 0 || logAt < 0 || logAt < envAt) return { ok: false, code: 'NOT_BUNDLE' };
    const envelopeText = t.slice(envAt + ENV_SECTION.length, logAt);
    const log = [];
    const rows = t.slice(logAt + LOG_SECTION.length).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (let j = 0; j < rows.length; j++) {
      try { log.push(JSON.parse(rows[j])); } catch (_e) { return { ok: false, code: 'LOG_LINE', line: j + 1 }; }
    }
    return { ok: true, envelopeText, log };
  }

  // ===== まとめ（画面から使う）=====
  function memoBytes(text) { return utf8(String(text || '')).length; }

  /**
   * 組を作る：鍵を作り、メモに封をし、カードに分け、最初の記録を書き、全部の組み合わせで試しに開ける。
   * holders は預け先の呼び名（n 個。空でもよい）。
   */
  async function createKit({ company = '', text, n, k, holders = [], now, rand = defaultRand }) {
    if (!String(text || '').trim()) throw new Error('メモが空です');
    if (memoBytes(text) > MEMO_MAX_BYTES) throw new Error('メモが長すぎます');
    const created = String(now || new Date().toISOString());
    const key = rand(KEY_BYTES);
    try {
      const cards = await makeCards(key, n, k, rand);
      const env = await sealMemo(key, cards.setId, cards.fpHead, { company, text, created }, rand);
      const envelopeLines = envelopeToLines(env);
      const names = Array.from({ length: n }, (_, i) => String(holders[i] || '').trim());
      const log = await appendLog([], {
        at: created, kind: '作成', who: '持ち主',
        note: `${n} 枚に分け、${k} 枚で開ける組を作った`,
        data: { company: String(company), n, k, set: setMark(cards.setId, cards.fpHead), holders: names, envelope: hex(await sha256(env)), lines: envelopeLines.length },
      });
      const selfTest = await selfTestKit(cards.codes, envelopeLines.join('\n'), k);
      return { codes: cards.codes, n, k, setId: cards.setId, fpHead: cards.fpHead, mark: setMark(cards.setId, cards.fpHead), envelope: env, envelopeLines, log, anchor: markOf(log[0].hash), holders: names, selfTest };
    } finally {
      key.fill(0);
    }
  }

  function subsets(n, k) {
    const out = [];
    const rec = (start, acc) => {
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (let i = start; i < n; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); }
    };
    rec(0, []);
    return out;
  }

  /** k 枚の全部の組み合わせで、封筒を打ち直した文字から開けてみる（作った直後の自分の確かめ）。 */
  async function selfTestKit(codes, envelopeText, k) {
    const all = subsets(codes.length, k);
    let passed = 0;
    for (const pick of all) {
      const r = await openKit(pick.map((i) => codes[i]), envelopeText);
      if (r.ok) passed++;
    }
    return { tried: all.length, passed };
  }

  /** もしもの時：カードと封筒（行の文字）から、メモを開ける。 */
  async function openKit(codes, envelopeText) {
    const env = parseEnvelopeText(envelopeText);
    if (!env.ok) return { ok: false, stage: 'envelope', error: env };
    const c = await combineCards(codes);
    if (!c.ok) return { ok: false, stage: 'cards', error: c };
    try {
      const h = envelopeHead(env.bytes);
      if (h.fpHead !== c.fpHead || h.setId !== c.setId) return { ok: false, stage: 'match', error: { code: 'WRONG_SET' } };
      const m = await openMemo(c.key, env.bytes);
      if (!m.ok) return { ok: false, stage: 'open', error: m };
      return { ok: true, memo: m.memo, used: c.used, k: c.k, n: c.n, mark: setMark(c.setId, c.fpHead) };
    } finally {
      c.key.fill(0);
    }
  }

  /** 点検：1 枚だけ読めるかを確かめる（秘密は戻さない）。記録（log）があれば、どの組の何枚目か・預け先も返す。 */
  function checkCard(code, log) {
    const p = parseCard(code);
    if (!p.ok) return p;
    const c = p.card;
    const res = { ok: true, x: c.x, n: c.n, k: c.k, mark: setMark(c.setId, c.fpHead), matches: null, holder: '' };
    const first = Array.isArray(log) && log[0] && log[0].data;
    if (first && first.set) {
      res.matches = first.set === res.mark;
      if (res.matches && Array.isArray(first.holders)) res.holder = first.holders[c.x - 1] || '';
    }
    return res;
  }

  // ===== 利用者向けの言葉 =====
  function cardErrorText(e, label) {
    const who = label || 'このカード';
    switch (e.code) {
      case 'EMPTY': return `${who}が空です。`;
      case 'CHAR': return `${who}に、カードに無い文字「${e.char}」があります（使う文字は 0〜9 と、I・L・O・U を除く英字です）。`;
      case 'LENGTH': return `${who}の文字の数が違います（今 ${e.got} 文字。正しくは ${CARD_CHARS} 文字＝4 文字の組が 16 個）。`;
      case 'TYPO': return `${who}は、どこかの書き写しが違います（1 文字以上）。カードと見比べてください。`;
      case 'VERSION': return `${who}は、この版では読めない形式です。`;
      default: return `${who}は、鍵の預け番のカードではないようです。`;
    }
  }
  function combineErrorText(e) {
    switch (e.code) {
      case 'NONE': return 'カードが入っていません。';
      case 'PARSE': return cardErrorText(e.reason, `${e.index} 番目の欄のカード`);
      case 'MIXED_KEY': return `${e.index} 番目の欄のカードは、ほかのカードと別の組です（組の印を見比べてください）。`;
      case 'MIXED_SET': return `${e.index} 番目の欄のカードは、作り直す前の古い組のカードです（組の印を見比べてください）。`;
      case 'DUPLICATE': return `同じカード（${e.x} 枚目）が 2 回入っています。別の人のカードを入れてください。`;
      case 'NOT_ENOUGH': return `カードが足りません（${e.need} 枚要ります。今は ${e.have} 枚）。`;
      case 'BAD_RESULT': return 'カードはそろいましたが、合いません。どれかのカードの書き写しが違う可能性があります。';
      default: return 'カードを読めませんでした。';
    }
  }
  function envelopeErrorText(e) {
    switch (e.code) {
      case 'EMPTY': return '封筒の文字が入っていません（「01:」で始まる行を全部入れてください）。';
      case 'LINE_FORMAT': return `封筒の ${e.line} 行目の形が違います（「${String(e.line).padStart(2, '0')}: ABCD EFGH … / K7」のように、番号・コロン・文字・斜線・2 文字の検査で 1 行です）。`;
      case 'LINE_TYPO': return `封筒の ${e.line} 行目の書き写しが違います（1 文字以上）。紙と見比べてください。`;
      case 'LINE_MISSING': return `封筒の ${e.line} 行目がありません（全部で ${e.total} 行です）。`;
      case 'LINE_DUP': return `封筒の ${e.line} 行目が 2 回あります。`;
      case 'CHAR': return `封筒の ${e.line} 行目に、使わない文字「${e.char}」があります。`;
      default: return 'これは鍵の預け番の封筒ではないようです。';
    }
  }
  function openErrorText(r) {
    if (r.stage === 'envelope') return envelopeErrorText(r.error);
    if (r.stage === 'cards') return combineErrorText(r.error);
    if (r.stage === 'match' || (r.error && r.error.code === 'WRONG_SET')) return 'カードと封筒が別の組です（カードと封筒の「組の印」を見比べてください）。';
    return '封筒が開きませんでした。封筒の文字が書き換えられているか、壊れています。';
  }
  function logErrorText(e) {
    switch (e.code) {
      case 'EMPTY': return '記録がありません。';
      case 'NUMBER': return `記録の ${e.line} 行目の番号が飛んでいるか、行が入れ替わっています。`;
      case 'LINK': return `記録の ${e.line} 行目が、前の行とつながりません（前の行が消された・入れ替えられた・書き換えられた）。`;
      case 'EDITED': return `記録の ${e.line} 行目の中身が、書いた後に変えられています。`;
      case 'FIRST': return '記録の最初の行が「作成」ではありません。';
      case 'ANCHOR': return 'カードに印刷した「記録の印」と、記録の最初の行が合いません（記録が作り直されています）。';
      default: return '記録を読めませんでした。';
    }
  }

  return {
    // 部品
    gfMul, gfDiv, shamirSplit, shamirCombine, crc16, crc10Bits, toBase32, fromBase32, normalizeCode, groupCode, hex, unhex, sha256,
    encodeCard, parseCard, makeCards, combineCards, setMark,
    sealMemo, openMemo, envelopeHead, envelopeToLines, parseEnvelopeText, lineCheck,
    canonicalJson, appendLog, verifyLog, markOf, bundleToText, parseBundle,
    // まとめ
    createKit, openKit, checkCard, selfTestKit, subsets, memoBytes,
    // 言葉
    cardErrorText, combineErrorText, envelopeErrorText, openErrorText, logErrorText,
    // 定数
    ALPHABET, KEY_BYTES, CARD_CHARS, MIN_N, MAX_N, MEMO_MAX_BYTES, LINE_CHARS,
  };
});
