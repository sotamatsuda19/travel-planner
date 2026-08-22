/**
 * 東京都・区市町村オープンデータ（CKAN 配布の CSV）を読むための共通処理。
 *
 *   - 文字コードが UTF-8 と Shift_JIS で混在している（同じ配布物の中でも混ざる）
 *   - 住所しか持たない表がある → 国土交通省 位置参照情報 で街区レベルまで座標化する
 *
 * どちらもデータ側の都合であって、呼ぶ側が気にする話ではないのでここに閉じ込める。
 */
import fs from "node:fs";
import path from "node:path";

// ------------------------------------------------------------------ CSV 読み

/** RFC4180 相当。改行入りの引用フィールドがあるので split(",") では壊れる。 */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cur);
      cur = "";
    } else if (c === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (c !== "\r") cur += c;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** UTF-8 として読めなければ Shift_JIS とみなす。BOM は落とす。 */
export function readCsv(file) {
  const buf = fs.readFileSync(file);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("shift_jis").decode(buf);
  }
  return parseCSV(text.replace(/^﻿/, ""));
}

/** ヘッダ行を見て {列名: 値} の配列にする。列名は重複しうるので最初の出現を採る。 */
export function readCsvObjects(file) {
  const rows = readCsv(file);
  if (rows.length < 2) return [];
  const header = rows[0];
  const idx = new Map();
  header.forEach((h, i) => {
    const k = h.trim();
    if (k && !idx.has(k)) idx.set(k, i);
  });
  return rows.slice(1).map((r) => {
    const o = {};
    for (const [k, i] of idx) o[k] = (r[i] ?? "").trim();
    return o;
  });
}

/** 有/無・yes/no・○×・「可」など、表ごとにバラバラな真偽表現を寄せる。 */
export function yesNo(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^(有|あり|有り|可|対応|yes|y|true|1|○|◯|〇)$/i.test(s)) return true;
  if (/^(無|なし|無し|不可|非対応|no|n|false|0|×|✕|－|-)$/i.test(s)) return false;
  return null;
}

export function num(v) {
  const n = Number(String(v ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// -------------------------------------------------------------- ジオコーダ

const KANJI_NUM = [
  "", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
  "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十",
  "二十一", "二十二", "二十三", "二十四", "二十五",
];

const blockIdx = new Map(); // "千代田区|丸の内一丁目|9" → 街区の代表点
const choIdx = new Map(); //   "千代田区|丸の内一丁目"     → 町丁目の代表点
const cities = new Set(); //   実在する市区町村名

/**
 * 国土交通省 位置参照情報（東京都）を読む。
 * 配布 zip の展開先はフォルダ名と中身が入れ替わっているので、
 * 名前ではなく列構成で街区レベル / 大字町丁目レベルを判定する。
 */
export function loadGeocoder(refDir) {
  if (blockIdx.size) return;
  const csvs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".csv")) csvs.push(p);
    }
  };
  if (!fs.existsSync(refDir)) return;
  walk(refDir);

  for (const file of csvs) {
    const rows = readCsv(file);
    const h = rows[0] || [];
    const at = (name) => h.indexOf(name);
    const iCity = at("市区町村名");
    const iLat = at("緯度");
    const iLon = at("経度");
    if (iCity < 0 || iLat < 0) continue;

    const iBlockOaza = at("大字・丁目名");
    const iBlock = at("街区符号・地番");
    const iChoOaza = at("大字町丁目名");

    for (const r of rows.slice(1)) {
      const city = (r[iCity] || "").trim();
      const lat = Number(r[iLat]);
      const lon = Number(r[iLon]);
      if (!city || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      cities.add(city);

      if (iBlockOaza >= 0 && iBlock >= 0) {
        const oaza = (r[iBlockOaza] || "").trim();
        if (!oaza) continue;
        const block = (r[iBlock] || "").trim().normalize("NFKC");
        blockIdx.set(`${city}|${oaza}|${block}`, { lat, lon });
        if (!choIdx.has(`${city}|${oaza}`)) choIdx.set(`${city}|${oaza}`, { lat, lon });
      } else if (iChoOaza >= 0) {
        const oaza = (r[iChoOaza] || "").trim();
        if (!oaza) continue;
        if (!choIdx.has(`${city}|${oaza}`)) choIdx.set(`${city}|${oaza}`, { lat, lon });
      }
    }
  }
}

/**
 * 住所文字列 → 座標。
 * precision は "street_block"（街区＝おおむね50m）か "chome"（町丁目の代表点＝数百m）。
 * ビル名・階数は無視する。cityHint は住所に市区町村が入っていない表のため。
 */
export function geocode(addr, cityHint = null) {
  let s = String(addr || "").normalize("NFKC").trim().replace(/^東京都/, "").trim();
  if (!s) return null;

  let city = cityHint ? String(cityHint).trim() : null;
  const cm = s.match(/^(.+?[区市町村])(.*)$/);
  if (cm && cities.has(cm[1])) {
    city = cm[1];
    s = cm[2];
  }
  if (!city) return null;
  // 「豊島区豊島区池袋…」のように市区町村が二重に入っている行がある
  if (s.startsWith(city)) s = s.slice(city.length);

  // 「一丁目」→「1-」、「9番1号」→「9-1」に寄せてから数字列を拾う
  s = s
    .replace(/([一二三四五六七八九十]+)丁目/g, (_, k) => {
      const n = KANJI_NUM.indexOf(k);
      return n > 0 ? `${n}-` : "-";
    })
    .replace(/丁目/g, "-")
    .replace(/(\d)\s*番地?/g, "$1-")
    .replace(/(\d)\s*号/g, "$1")
    .replace(/[−ー―‐]/g, "-")
    .trim();

  const m = s.match(/^([^\d\-]+)[\s-]*(\d+)?[\s-]*(\d+)?/);
  if (!m || !m[1]) return null;
  const base = m[1].replace(/[\s　]/g, "");
  const n1 = m[2] ? Number(m[2]) : null;
  const n2 = m[3] ? Number(m[3]) : null;

  // 「丸の内1-9-1」は 丸の内一丁目/9番 とも 丸の内/1番 とも読める。丁目つきを先に試す。
  const tries = [];
  if (n1 && KANJI_NUM[n1]) tries.push({ oaza: `${base}${KANJI_NUM[n1]}丁目`, block: n2 });
  tries.push({ oaza: base, block: n1 });

  for (const t of tries) {
    if (t.block == null) continue;
    const hit = blockIdx.get(`${city}|${t.oaza}|${t.block}`);
    if (hit) return { ...hit, precision: "street_block", city, oaza: t.oaza };
  }
  for (const t of tries) {
    const hit = choIdx.get(`${city}|${t.oaza}`);
    if (hit) return { ...hit, precision: "chome", city, oaza: t.oaza };
  }
  return null;
}
