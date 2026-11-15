// 鍵の預け番：画面（通信なし。利用者の文字は textContent でだけ画面に出す）。
(function () {
  'use strict';
  const E = window.AzukeEngine;
  const $ = (id) => document.getElementById(id);

  /** 要素を作る。子は文字か要素。 */
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }
  function say(target, text, kind) {
    const box = typeof target === 'string' ? $(target) : target;
    box.className = 'msg' + (kind ? ' ' + kind : '');
    box.replaceChildren(...String(text || '').split('\n').map((t, i) => (i ? [el('br'), t] : t)).flat());
  }
  function today() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }
  function dateJa(iso) { const d = new Date(iso); return isNaN(d) ? String(iso) : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
  function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30); }
  function download(text, name) {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function readFile(input) {
    return new Promise((resolve, reject) => {
      const f = input.files && input.files[0];
      if (!f) { resolve(null); return; }
      if (f.size > 2 * 1024 * 1024) { reject(new Error('ファイルが大きすぎます（2MB まで）。')); return; }
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, text: String(r.result || '') });
      r.onerror = () => reject(new Error('ファイルを読めませんでした。'));
      r.readAsText(f, 'utf-8');
    });
  }

  // ===== タブ =====
  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.setAttribute('aria-pressed', String(t === b));
      for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== 'tab-' + b.dataset.tab;
    });
  }

  // ===== ① 作る =====
  const nSel = $('n'), kSel = $('k');
  for (let i = E.MIN_N; i <= E.MAX_N; i++) nSel.append(el('option', { value: String(i) }, `${i} 人`));
  nSel.value = '3';
  function fillK() {
    const n = Number(nSel.value), old = Number(kSel.value) || 2;
    kSel.replaceChildren(...Array.from({ length: n - 1 }, (_, i) => el('option', { value: String(i + 2) }, `${i + 2} 人`)));
    kSel.value = String(Math.min(old, n));
  }
  function fillHolders() {
    const n = Number(nSel.value);
    const box = $('holders');
    const old = Array.from(box.querySelectorAll('input')).map((x) => x.value);
    box.replaceChildren(...Array.from({ length: n }, (_, i) => el('p', {},
      el('label', { for: 'holder' + i }, `${i + 1} 枚目を預ける人`), el('br'),
      Object.assign(el('input', { type: 'text', id: 'holder' + i, maxlength: '30', autocomplete: 'off' }), { value: old[i] || '' }))));
  }
  function explainNK() {
    const n = Number(nSel.value), k = Number(kSel.value);
    $('nk-explain').textContent = `${n} 人に1枚ずつ預け、そのうち ${k} 人がそろえば開けます。${n - k} 人が連絡がつかない・カードを失くしても開けられます。${k - 1} 人までなら、集まっても開けられません。`;
  }
  function memoCount() {
    const bytes = E.memoBytes($('memo').value);
    const lines = Math.ceil(((bytes + 120) * 8) / 5 / E.LINE_CHARS);   // 見出し・検査・会社名のぶんを含めた目安
    const over = bytes > E.MEMO_MAX_BYTES;
    $('memo-count').textContent = `${$('memo').value.length} 文字（封筒はおよそ ${lines} 行）` + (over ? ' ⚠ 長すぎます。短くしてください。' : lines > 30 ? ' 長めです。もしもの時に打ち直す手間が増えます。' : '');
    $('memo-count').className = 'small' + (over ? ' bad' : '');
  }
  nSel.addEventListener('change', () => { fillK(); fillHolders(); explainNK(); });
  kSel.addEventListener('change', explainNK);
  $('memo').addEventListener('input', memoCount);
  fillK(); fillHolders(); explainNK(); memoCount();

  $('sample').addEventListener('click', () => {
    $('company').value = 'やまだ青果店（架空）';
    $('memo').value = [
      '【見本・架空です】',
      '・パスワード管理アプリ（架空の名前「カギノート」）の親パスワード：sample-Kaki-Nashi-2026',
      '・事務所の金庫：右に4回 18、左に3回 52、右に2回 07',
      '・ホームページの管理：架空ドメイン社。ログインの方法は金庫の青いファイル',
      '・取引銀行：架空銀行 中央支店（担当 田中さん 06-0000-0000）。窓口で手続きが要る',
      '・顧問の先生：架空会計事務所 06-0000-0001',
    ].join('\n');
    nSel.value = '3'; fillK(); kSel.value = '2'; fillHolders();
    ['妻（花子）', '専務（佐藤）', '顧問の先生'].forEach((v, i) => { $('holder' + i).value = v; });
    explainNK(); memoCount();
  });

  let made = null;   // 作った組（画面から消すまで持つ）
  $('make').addEventListener('click', async () => {
    const text = $('memo').value;
    if (!text.trim()) { say('make-msg', 'メモが空です。', 'bad'); return; }
    if (E.memoBytes(text) > E.MEMO_MAX_BYTES) { say('make-msg', 'メモが長すぎます。短くしてください。', 'bad'); return; }
    const n = Number(nSel.value), k = Number(kSel.value);
    const holders = Array.from({ length: n }, (_, i) => $('holder' + i).value);
    $('make').disabled = true;
    say('make-msg', '作っています…');
    try {
      made = await E.createKit({ company: $('company').value.trim(), text, n, k, holders });
      made.company = $('company').value.trim();
      made.created = made.log[0].at;
      if (made.selfTest.passed !== made.selfTest.tried) throw new Error('作った直後の確かめが合いませんでした。もう一度作ってください。');
      say('make-msg', `できました。${k} 枚の全部の組み合わせ（${made.selfTest.tried} 通り）で、試しに開けて確かめました。`, 'good');
      showMade();
    } catch (e) {
      made = null;
      say('make-msg', e.message || String(e), 'bad');
    } finally {
      $('make').disabled = false;
    }
  });

  function showMade() {
    $('made').hidden = false;
    $('made-summary').replaceChildren(
      el('p', {}, '組の印：', el('strong', { class: 'mono' }, made.mark), '（カードと封筒に印刷。同じ組かを見分けるため）'),
      el('p', {}, '記録の印：', el('strong', { class: 'mono' }, made.anchor), '（作った時の記録の指紋。記録を後から作り直すと分かる）'),
      el('p', {}, `${made.n} 枚・${made.k} 枚で開ける・封筒 ${made.envelopeLines.length} 行`));
    $('made-cards').replaceChildren(...made.codes.map((c, i) => el('div', { class: 'card-preview' },
      el('p', {}, el('strong', {}, `${i + 1} / ${made.n} 枚目`), made.holders[i] ? `（${made.holders[i]}）` : ''),
      el('p', { class: 'mono code-lines' }, ...codeLines(c).map((l, j) => (j ? [el('br'), l] : l)).flat()))));
    buildPrint();
  }
  function codeLines(code) { const g = code.split('-'); return [0, 4, 8, 12].map((s) => g.slice(s, s + 4).join(' - ')); }

  function buildPrint() {
    const p = $('print-area');
    const pages = made.codes.map((code, i) => el('section', { class: 'sheet' },
      el('h1', {}, `鍵の預け番　カード ${i + 1} / ${made.n}`),
      el('p', { class: 'big' }, made.company ? `${made.company} のもしもの時のメモ` : 'もしもの時のメモ'),
      el('table', { class: 'facts' },
        el('tr', {}, el('th', {}, '預け先'), el('td', {}, made.holders[i] || '（　　　　　　　　）')),
        el('tr', {}, el('th', {}, '開け方'), el('td', {}, `${made.n} 枚のうち ${made.k} 枚がそろうと開けられます。1枚だけでは何も分かりません。`)),
        el('tr', {}, el('th', {}, '組の印'), el('td', { class: 'mono' }, made.mark)),
        el('tr', {}, el('th', {}, '記録の印'), el('td', { class: 'mono' }, made.anchor)),
        el('tr', {}, el('th', {}, '作った日'), el('td', {}, dateJa(made.created)))),
      el('h2', {}, 'あなたのカードの文字（4文字ずつ16組）'),
      el('div', { class: 'codebox mono' }, ...codeLines(code).map((l) => el('div', {}, l))),
      el('h2', {}, '預かった方へのお願い'),
      el('ul', {},
        el('li', {}, 'ほかの人のカードと一緒に保管しないでください。写真に撮ってネットに上げないでください。'),
        el('li', {}, 'もしもの時（持ち主の急病・事故など）は、ほかの預け先と連絡を取り、カードを持ち寄ってください。'),
        el('li', {}, '開けるには「鍵の預け番」の画面の「③ 開ける」で、カードの文字と、下の封筒の行を打ち込みます。'),
        el('li', {}, '年に1回、「② 点検する」で読めるか確かめ、日付と最新の印を下の余白に書いてください。')),
      el('h2', {}, '封筒（全員のカードに同じものが印刷されています）'),
      el('div', { class: 'envbox mono' }, ...made.envelopeLines.map((l) => el('div', {}, l))),
      el('h2', {}, '点検の記録（手書き）'),
      el('table', { class: 'handwrite' }, el('tr', {}, el('th', {}, '日付'), el('th', {}, '点検した人'), el('th', {}, '最新の印')),
        ...[1, 2, 3].map(() => el('tr', {}, el('td', {}, ''), el('td', {}, ''), el('td', {}, '')))),
    ));
    const owner = el('section', { class: 'sheet' },
      el('h1', {}, '鍵の預け番　持ち主の控え'),
      el('p', {}, 'この紙にはカードの文字は入っていません。これだけでは開けられません。'),
      el('table', { class: 'facts' },
        el('tr', {}, el('th', {}, '組の印'), el('td', { class: 'mono' }, made.mark)),
        el('tr', {}, el('th', {}, '記録の印'), el('td', { class: 'mono' }, made.anchor)),
        el('tr', {}, el('th', {}, '作った日'), el('td', {}, dateJa(made.created))),
        el('tr', {}, el('th', {}, '開け方'), el('td', {}, `${made.n} 枚のうち ${made.k} 枚`)),
        ...made.holders.map((h, i) => el('tr', {}, el('th', {}, `${i + 1} 枚目`), el('td', {}, h || '（未記入）')))),
      el('h2', {}, '封筒'),
      el('div', { class: 'envbox mono' }, ...made.envelopeLines.map((l) => el('div', {}, l))));
    p.replaceChildren(...pages, owner);
  }

  $('print-btn').addEventListener('click', () => { if (made) window.print(); });
  $('save').addEventListener('click', () => {
    if (!made) return;
    const title = `${made.company || '（名前なし）'}　組の印 ${made.mark}　記録の印 ${made.anchor}　作った日 ${dateJa(made.created)}`;
    download(E.bundleToText({ title, envelopeLines: made.envelopeLines, log: made.log }), `鍵の預け番_${safeName(made.company) || '控え'}_${today()}.txt`);
  });
  $('clear').addEventListener('click', () => {
    made = null;
    $('made').hidden = true;
    $('made-cards').replaceChildren(); $('print-area').replaceChildren(); $('made-summary').replaceChildren();
    $('memo').value = ''; memoCount();
    say('make-msg', '画面から消しました。');
  });

  // ===== 読み込んだファイル（点検・開ける・記録で使う）=====
  function loadBundleFrom(inputId, nameId, onLoaded) {
    $(inputId).addEventListener('change', async () => {
      try {
        const f = await readFile($(inputId));
        if (!f) return;
        const b = E.parseBundle(f.text);
        if (!b.ok) { $(nameId).textContent = `「${f.name}」は鍵の預け番のファイルではないようです。`; onLoaded(null); return; }
        $(nameId).textContent = `「${f.name}」を読みました。`;
        onLoaded({ name: f.name, text: f.text, envelopeText: b.envelopeText, log: b.log });
      } catch (e) { $(nameId).textContent = e.message; onLoaded(null); }
      finally { $(inputId).value = ''; }
    });
  }
  async function saveWithEntry(bundle, entry) {
    const v = await E.verifyLog(bundle.log);
    if (!v.ok) throw new Error('記録が壊れているので、足せません：' + E.logErrorText(v));
    const log = await E.appendLog(bundle.log, entry);
    const env = E.parseEnvelopeText(bundle.envelopeText);
    if (!env.ok) throw new Error(E.envelopeErrorText(env));
    const first = log[0].data || {};
    const title = `${first.company || '（名前なし）'}　組の印 ${first.set || ''}　記録の印 ${E.markOf(log[0].hash)}　最新の印 ${E.markOf(log[log.length - 1].hash)}`;
    download(E.bundleToText({ title, envelopeLines: E.envelopeToLines(env.bytes), log }), bundle.name.replace(/(\.txt)?$/, '') .replace(/_\d{8}$/, '') + `_${today()}.txt`);
    bundle.log = log;
    return E.markOf(log[log.length - 1].hash);
  }

  // ===== ② 点検 =====
  let checkBundle = null, lastCheck = null;
  loadBundleFrom('check-file', 'check-file-name', (b) => { checkBundle = b; });
  $('check').addEventListener('click', () => {
    const r = E.checkCard($('check-code').value, checkBundle && checkBundle.log);
    lastCheck = r.ok ? r : null;
    $('check-log').hidden = true;
    if (!r.ok) { say('check-result', E.cardErrorText(r), 'bad'); return; }
    const lines = [`読めます。${r.n} 枚のうちの ${r.x} 枚目です（${r.k} 枚で開ける組）。組の印：${r.mark}`];
    if (r.matches === true) { lines.push(`読み込んだファイルと同じ組です。預け先：${r.holder || '（未記入）'}`); $('check-log').hidden = false; }
    if (r.matches === false) lines.push('⚠ 読み込んだファイルとは別の組のカードです（作り直す前の古いカードかもしれません）。');
    say('check-result', lines.join('\n'), r.matches === false ? 'bad' : 'good');
  });
  $('check-save').addEventListener('click', async () => {
    if (!checkBundle || !lastCheck) return;
    try {
      const latest = await saveWithEntry(checkBundle, { at: new Date().toISOString(), kind: '点検', who: $('check-who').value.trim(), note: `${lastCheck.x} 枚目が読めた`, data: { card: lastCheck.x } });
      say('check-result', `記録に足して保存しました。最新の印：${latest}（カードの余白に手書きしておくと安心です）`, 'good');
      $('check-log').hidden = true;
    } catch (e) { say('check-result', e.message, 'bad'); }
  });

  // ===== ③ 開ける =====
  function addCodeField() {
    const box = $('open-codes');
    const i = box.children.length + 1;
    box.append(el('p', {}, el('label', { for: 'oc' + i }, `${i} 枚目のカード`), el('br'),
      el('textarea', { id: 'oc' + i, rows: '2', class: 'wide code', spellcheck: 'false', autocomplete: 'off' })));
  }
  for (let i = 0; i < 3; i++) addCodeField();
  $('open-add').addEventListener('click', () => { if ($('open-codes').children.length < E.MAX_N) addCodeField(); });
  let openBundle = null;
  loadBundleFrom('open-file', 'open-file-name', (b) => { openBundle = b; if (b) $('open-env').value = b.envelopeText.trim(); });
  $('open').addEventListener('click', async () => {
    $('opened').hidden = true;
    const codes = Array.from($('open-codes').querySelectorAll('textarea')).map((t) => t.value);
    say('open-msg', '確かめています…');
    const r = await E.openKit(codes, $('open-env').value);
    if (!r.ok) { say('open-msg', E.openErrorText(r), 'bad'); return; }
    say('open-msg', `開きました（${r.n} 枚のうち ${r.used.join('・')} 枚目を使いました。組の印：${r.mark}）。`, 'good');
    $('opened-memo').replaceChildren(
      el('p', { class: 'small' }, `${r.memo.company || ''}　作った日：${dateJa(r.memo.created)}`),
      el('pre', { class: 'memo-text' }, r.memo.text));
    $('opened').hidden = false;
    $('open-log').hidden = !(openBundle && openBundle.log && openBundle.log[0] && openBundle.log[0].data && openBundle.log[0].data.set === r.mark);
    $('open-log').dataset.used = r.used.join(',');
  });
  $('open-save').addEventListener('click', async () => {
    try {
      const latest = await saveWithEntry(openBundle, { at: new Date().toISOString(), kind: '開封', who: $('open-who').value.trim(), note: `${$('open-log').dataset.used} 枚目のカードで開けた`, data: { cards: $('open-log').dataset.used.split(',').map(Number) } });
      say('open-msg', `開けたことを記録に足して保存しました。最新の印：${latest}`, 'good');
      $('open-log').hidden = true;
    } catch (e) { say('open-msg', e.message, 'bad'); }
  });
  $('open-clear').addEventListener('click', () => {
    $('opened').hidden = true; $('opened-memo').replaceChildren();
    for (const t of $('open-codes').querySelectorAll('textarea')) t.value = '';
    $('open-env').value = ''; openBundle = null; $('open-file-name').textContent = '';
    say('open-msg', '画面から消しました。');
  });

  // ===== ④ 記録 =====
  let logBundle = null;
  loadBundleFrom('log-file', 'log-file-name', (b) => { logBundle = b; });
  $('log-check').addEventListener('click', async () => {
    $('log-table').replaceChildren();
    if (!logBundle) { say('log-msg', 'ファイルを選んでください。', 'bad'); return; }
    const v = await E.verifyLog(logBundle.log, $('log-anchor').value.trim() || null);
    const rows = logBundle.log.map((e, j) => el('tr', { class: !v.ok && v.line === j + 1 ? 'broken' : '' },
      el('td', {}, String(e.i)), el('td', {}, dateJa(e.at)), el('td', {}, e.kind), el('td', {}, e.who || ''), el('td', {}, e.note || ''),
      el('td', { class: 'mono' }, E.markOf(e.hash))));
    $('log-table').append(el('table', { class: 'logt' }, el('tr', {}, ...['番号', '日時', '何を', '誰が', 'メモ', '印'].map((h) => el('th', {}, h))), ...rows));
    if (!v.ok) { say('log-msg', E.logErrorText(v), 'bad'); return; }
    const env = E.parseEnvelopeText(logBundle.envelopeText);
    let envNote = '';
    if (env.ok) {
      const h = E.hex(await E.sha256(env.bytes));
      envNote = logBundle.log[0].data && logBundle.log[0].data.envelope === h ? '封筒も作った時のままです。' : '⚠ 封筒が、作った時の記録と違います。';
    }
    say('log-msg', `書き換えは見つかりませんでした（${v.lines} 行）。記録の印：${v.anchor}　最新の印：${v.latest}　${envNote}` + ($('log-anchor').value.trim() ? '\nカードの記録の印とも合っています。' : '\nカードの「記録の印」を入れると、作り直されていないかも確かめられます。'), envNote.startsWith('⚠') ? 'bad' : 'good');
  });
})();
