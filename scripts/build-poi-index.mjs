#!/usr/bin/env node
/**
 * オープンデータ → POI 検索インデックス
 *
 * 入力（すべて hackathon_2026/data 配下、既存のオープンデータ）
 *   - 03_geospatial/openstreetmap/*.geojson          (OSM / ODbL)
 *   - 08_merged_tokyo_spots/tokyo_spots.jsonl        (OSM + Wikidata + Wikivoyage)
 *   - 04_ward_opendata/東京都デジタルサービス局/…「だれでも東京」  (東京都 / CC-BY-4.0)
 *   - 04_ward_opendata/東京都産業労働局/東京都内の飲食店のバリアフリー情報 (東京都 / CC-BY-4.0)
 *   - 04_ward_opendata/<区>/宿泊施設（旅館台帳）      (各区 / CC-BY-4.0)
 *   - 03_geospatial/位置参照情報                      (国土交通省。住所しか無い表の座標化用)
 *
 * 出力
 *   - data/poi.jsonl    1行1スポット（検索用テキスト付き）
 *   - data/areas.json   地名・駅名 → 座標（near の解決用）
 *   - data/stations.json 鉄道駅（transit ルートの近似に使う）
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { geocode, loadGeocoder, readCsvObjects } from "./lib/opendata.mjs";
import {
  accessFromDaredemo,
  accessFromOsm,
  accessFromRestaurantCsv,
  accessWords,
  mergeAccess,
} from "./lib/accessibility.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA_SRC = path.resolve(ROOT, "..", "data");
const OSM = path.join(DATA_SRC, "03_geospatial", "openstreetmap");
const MERGED = path.join(DATA_SRC, "08_merged_tokyo_spots", "tokyo_spots.jsonl");
const WARD = path.join(DATA_SRC, "04_ward_opendata");
const ADDR_REF = path.join(DATA_SRC, "03_geospatial", "位置参照情報");
const OUT_DIR = path.join(ROOT, "data");

// ---------------------------------------------------------------- 語彙テーブル

/** amenity/shop/tourism などの英語タグ → 日本語の検索キーワード */
const TAG_WORDS = {
  // 飲食
  restaurant: ["レストラン", "飲食店", "ごはん", "ご飯", "食事", "ランチ", "ディナー"],
  cafe: ["カフェ", "喫茶店", "コーヒー", "お茶"],
  fast_food: ["ファストフード", "軽食"],
  bar: ["バー", "飲み"],
  pub: ["パブ", "居酒屋", "飲み"],
  biergarten: ["ビアガーデン", "ビール"],
  ice_cream: ["アイス", "ジェラート", "スイーツ"],
  food_court: ["フードコート"],
  // 料理ジャンル (cuisine)
  ramen: ["ラーメン", "らーめん", "拉麺", "中華そば", "つけ麺"],
  noodle: ["麺", "ラーメン"],
  sushi: ["寿司", "すし", "鮨", "回転寿司"],
  japanese: ["和食", "日本料理", "定食"],
  izakaya: ["居酒屋", "飲み"],
  yakiniku: ["焼肉", "焼き肉"],
  yakitori: ["焼き鳥", "焼鳥"],
  udon: ["うどん"],
  soba: ["そば", "蕎麦"],
  tonkatsu: ["とんかつ", "トンカツ"],
  tempura: ["天ぷら", "てんぷら"],
  curry: ["カレー"],
  indian: ["インド料理", "カレー"],
  chinese: ["中華", "中華料理", "中国料理"],
  korean: ["韓国料理", "焼肉"],
  italian: ["イタリアン", "イタリア料理", "パスタ"],
  pizza: ["ピザ", "ピッツァ"],
  french: ["フレンチ", "フランス料理"],
  thai: ["タイ料理"],
  vietnamese: ["ベトナム料理", "フォー"],
  spanish: ["スペイン料理", "バル"],
  mexican: ["メキシコ料理"],
  american: ["アメリカン"],
  burger: ["ハンバーガー", "バーガー"],
  steak: ["ステーキ", "肉"],
  seafood: ["海鮮", "魚"],
  bbq: ["バーベキュー", "焼肉"],
  gyoza: ["餃子", "ぎょうざ"],
  okonomiyaki: ["お好み焼き", "もんじゃ"],
  donburi: ["丼", "どんぶり"],
  teishoku: ["定食"],
  cake: ["ケーキ", "スイーツ", "デザート"],
  dessert: ["スイーツ", "デザート"],
  bakery: ["パン", "ベーカリー", "パン屋"],
  sandwich: ["サンドイッチ"],
  coffee_shop: ["コーヒー", "カフェ"],
  bubble_tea: ["タピオカ", "タピオカミルクティー"],
  crepe: ["クレープ"],
  friture: ["揚げ物"],
  // 観光・施設
  museum: ["美術館", "博物館", "ミュージアム"],
  gallery: ["ギャラリー", "美術館"],
  tourism: ["観光", "観光スポット", "名所"],
  attraction: ["観光スポット", "名所", "アトラクション"],
  theme_park: ["遊園地", "テーマパーク"],
  zoo: ["動物園"],
  aquarium: ["水族館"],
  park: ["公園", "散歩"],
  garden: ["庭園", "公園"],
  historic: ["史跡", "歴史", "旧跡"],
  castle: ["城"],
  monument: ["記念碑", "史跡"],
  ruins: ["遺跡"],
  worship: ["神社", "お寺", "寺", "寺院", "参拝"],
  shinto: ["神社", "参拝"],
  buddhist: ["寺", "お寺", "寺院"],
  onsen: ["温泉", "銭湯", "サウナ", "お風呂"],
  viewpoint: ["展望", "夜景", "景色", "眺め", "展望台"],
  theatre: ["劇場", "演劇"],
  cinema: ["映画館", "映画"],
  // 買い物
  department_store: ["デパート", "百貨店", "買い物"],
  mall: ["ショッピングモール", "買い物"],
  gift: ["お土産", "おみやげ", "土産"],
  confectionery: ["お菓子", "スイーツ", "お土産"],
  books: ["書店", "本屋"],
  // 宿泊
  hotel: ["ホテル", "宿", "宿泊", "泊まる", "泊まれる"],
  ryokan: ["旅館", "宿", "宿泊", "泊まる"],
  hostel: ["ゲストハウス", "ホステル", "簡易宿所", "ドミトリー", "安宿", "宿", "宿泊", "泊まる"],
  guest_house: ["ゲストハウス", "民宿", "宿", "宿泊", "泊まる"],
  apartment: ["アパートメント", "コンドミニアム", "宿泊", "泊まる"],
  capsule_hotel: ["カプセルホテル", "宿泊", "泊まる"],
  love_hotel: ["ホテル", "宿泊"],
  motel: ["モーテル", "宿泊"],
  camp_site: ["キャンプ場", "キャンプ"],
  chalet: ["コテージ", "宿泊"],
  // 交通
  station: ["駅"],
  // 公共設備（自治体オープンデータ的な用途）
  toilets: ["トイレ", "お手洗い", "公衆トイレ"],
  wifi: ["Wi-Fi", "wifi", "無料Wi-Fi"],
  bench: ["ベンチ", "休憩"],
  shelter: ["休憩所", "休憩"],
};

const CATEGORY_LABEL = {
  restaurant: "レストラン",
  cafe: "カフェ",
  fast_food: "ファストフード",
  bar: "バー",
  pub: "居酒屋",
  ice_cream: "アイス",
  food_court: "フードコート",
  biergarten: "ビアガーデン",
  museum: "美術館・博物館",
  gallery: "ギャラリー",
  attraction: "観光スポット",
  tourism: "観光スポット",
  theme_park: "遊園地",
  zoo: "動物園",
  aquarium: "水族館",
  park: "公園",
  garden: "庭園",
  historic: "史跡",
  worship: "神社・寺",
  onsen: "温泉・銭湯",
  viewpoint: "展望スポット",
  theatre: "劇場",
  cinema: "映画館",
  department_store: "百貨店",
  mall: "ショッピングモール",
  gift: "お土産",
  confectionery: "菓子店",
  books: "書店",
  bakery: "ベーカリー",
  station: "駅",
  toilets: "公衆トイレ",
  facility: "公共設備",
  hotel: "ホテル・旅館",
  ryokan: "旅館",
  hostel: "簡易宿所・ゲストハウス",
  guest_house: "ゲストハウス",
  apartment: "アパートメント",
  capsule_hotel: "カプセルホテル",
  love_hotel: "ホテル",
  motel: "モーテル",
  camp_site: "キャンプ場",
  chalet: "コテージ",
};

// -------------------------------------------------------------- ユーティリティ

/** 検索用の正規化：NFKC + 小文字化 + カタカナ→ひらがな */
export function normalize(s) {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[・･\s]+/g, " ")
    .trim();
}

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

function addrOf(p) {
  const city = p["addr:city"] || p["addr:suburb"] || p["addr:province"] || "";
  const hood = p["addr:neighbourhood"] || p["addr:quarter"] || "";
  return { city, hood };
}

function nameOf(p) {
  return (
    p["name:ja"] || p.name || p.official_name || p["official_name:ja"] || p["name:en"] || ""
  );
}

// ------------------------------------------------------------------ 変換ロジック

function wordsFor(tokens) {
  const out = [];
  for (const t of tokens) {
    if (!t) continue;
    for (const piece of String(t).split(/[;,]/)) {
      const key = piece.trim();
      if (TAG_WORDS[key]) out.push(...TAG_WORDS[key]);
      out.push(key);
    }
  }
  return uniq(out);
}

function baseRecord({
  id,
  name,
  lat,
  lon,
  cats,
  words,
  props = {},
  desc = null,
  source,
  access = null,
  approx = false,
}) {
  const { city, hood } = addrOf(props);
  const searchText = normalize(
    [
      name,
      props["name:en"],
      props["name:ja-Hira"],
      props["name:ja_rm"],
      props.brand,
      props.branch,
      props.operator,
      ...words,
      ...cats.map((c) => CATEGORY_LABEL[c]).filter(Boolean),
      ...accessWords(access),
      city,
      hood,
      desc ? String(desc).slice(0, 400) : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  return {
    id,
    name,
    name_en: props["name:en"] || null,
    cats,
    label: CATEGORY_LABEL[cats[0]] || cats[0] || "スポット",
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    city: city || null,
    hood: hood || null,
    hours: props.opening_hours || null,
    website: props.website || props["contact:website"] || null,
    phone: props.phone || props["contact:phone"] || null,
    desc: desc ? String(desc).replace(/\s+/g, " ").trim().slice(0, 400) : null,
    source,
    /** バリアフリー等の設備情報。値が分かっている項目だけが入る（null と false は別物） */
    access: access || null,
    /** true なら座標は住所からの推定（街区〜町丁目の代表点）で、建物のピンポイントではない */
    approx: approx || undefined,
    s: searchText,
  };
}

function readGeoJSON(file) {
  const full = path.join(OSM, file);
  if (!fs.existsSync(full)) {
    console.warn(`  ! skip (not found): ${file}`);
    return [];
  }
  return JSON.parse(fs.readFileSync(full, "utf8")).features || [];
}

function coords(f) {
  const g = f.geometry;
  if (!g) return null;
  if (g.type === "Point") return g.coordinates;
  if (g.type === "Polygon" && g.coordinates?.[0]?.length) {
    const ring = g.coordinates[0];
    const [sx, sy] = ring.reduce(([x, y], c) => [x + c[0], y + c[1]], [0, 0]);
    return [sx / ring.length, sy / ring.length];
  }
  return null;
}

// ------------------------------------------------------------------------ main

const records = [];
const seen = new Set();
/** 正規化した施設名 → レコード。あとから来るバリアフリー情報を突き合わせるのに使う。 */
const byName = new Map();

/** 自治体 CSV の施設名は半角カナ・全角英数が混在している。表示用に整える。 */
function cleanName(s) {
  return String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 施設名の表記ゆれ吸収。突合キー専用（検索テキストの normalize より強く削る）。 */
function nameKey(s) {
  return normalize(s).replace(/[（）()【】「」'’`"、,.\-＆&･・\s]+/g, "");
}

/** 「東京体育館（メインアリーナ）」→「東京体育館」。施設の内訳行を親施設に寄せるための第2キー。 */
function bareKey(s) {
  const stripped = String(s).replace(/[（(][^）)]*[）)]/g, "").replace(/[＜<][^＞>]*[＞>]/g, "");
  return nameKey(stripped);
}

function indexName(rec) {
  for (const k of new Set([nameKey(rec.name), bareKey(rec.name)])) {
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(rec);
  }
}

function push(rec) {
  if (!rec || !rec.name || !Number.isFinite(rec.lat) || !Number.isFinite(rec.lon)) return null;
  const key = `${rec.name}@${rec.lat.toFixed(4)},${rec.lon.toFixed(4)}`;
  if (seen.has(key)) return null;
  seen.add(key);
  records.push(rec);
  indexName(rec);
  return rec;
}

const metersBetween = (aLat, aLon, bLat, bLon) => {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * 同名かつ近いレコードを探す。
 * 名前だけで繋ぐと「セブンイレブン」が全部1件になるので、距離の上限は必ず要る。
 */
function findExisting(name, lat, lon, maxM = 400) {
  for (const key of new Set([nameKey(name), bareKey(name)])) {
    if (!key) continue;
    const cands = byName.get(key);
    if (!cands) continue;
    let best = null;
    for (const rec of cands) {
      const d = metersBetween(lat, lon, rec.lat, rec.lon);
      if (d <= maxM && (!best || d < best.d)) best = { rec, d };
    }
    if (best) return best.rec;
  }
  return null;
}

/**
 * 駅名だけで既存の駅レコードを引く（同名の出入口・ホームが複数あるので全部返す）。
 * 04_交通.csv の座標は壊れている（JR の110行が同一の誤った点を指す）ため、
 * 駅に限っては座標を使わず名前で解決する。
 */
function findStationsByName(raw) {
  const cleaned = String(raw)
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[＜<][^＞>]*[＞>]/g, "")
    .trim();
  const last = cleaned.split(/[\s　]+/).pop() || cleaned;
  const base = last.replace(/駅$/, "");
  // 「千駄ヶ谷」と「千駄ケ谷」、「市ヶ谷」と「市ケ谷」の揺れを吸収する
  const variants = new Set([base, base.replace(/ヶ/g, "ケ"), base.replace(/ケ/g, "ヶ")]);
  for (const v of variants) {
    const cands = (byName.get(nameKey(`${v}駅`)) || []).filter((r) => r.cats[0] === "station");
    if (cands.length) return cands;
  }
  return [];
}

/**
 * 既存レコードのカテゴリを貼り替える。
 * tokyo_spots.jsonl は宿泊施設まで "tourism"（観光スポット）で持っているので、
 * OSM の tourism=hotel 等を突き合わせて「ホテル」「泊まれる」で引ける状態に直す。
 */
function relabel(rec, cat) {
  if (rec.cats[0] === cat) return rec;
  rec.cats = uniq([cat, ...rec.cats]);
  rec.label = CATEGORY_LABEL[cat] || rec.label;
  rec.s = normalize(`${rec.s} ${wordsFor([cat]).join(" ")} ${CATEGORY_LABEL[cat] || ""}`);
  return rec;
}

/** 既存レコードにバリアフリー情報を足し、検索テキストを張り直す。 */
function applyAccess(rec, access, sourceLabel) {
  rec.access = mergeAccess(rec.access, access);
  const words = accessWords(rec.access);
  if (words.length) rec.s = normalize(`${rec.s} ${words.join(" ")}`);
  if (sourceLabel && !rec.source.includes(sourceLabel)) rec.source = `${rec.source} + ${sourceLabel}`;
  return rec;
}

// 1) 飲食店（OSM food_drink）
console.log("• food_drink.geojson");
for (const f of readGeoJSON("food_drink.geojson")) {
  const p = f.properties || {};
  const c = coords(f);
  const name = nameOf(p);
  if (!c || !name) continue;
  const amenity = p.amenity || "restaurant";
  const cuisines = (p.cuisine || "").split(";").map((s) => s.trim()).filter(Boolean);
  push(
    baseRecord({
      id: `osm:${p.osm_type}:${p.osm_id}`,
      name,
      lon: c[0],
      lat: c[1],
      cats: uniq([amenity, ...cuisines]),
      words: wordsFor([amenity, ...cuisines]),
      props: p,
      access: accessFromOsm(p),
      source: "OpenStreetMap",
    }),
  );
}

// 2) 観光・文化スポット（統合済み tokyo_spots.jsonl：説明文つき）
console.log("• tokyo_spots.jsonl");
if (fs.existsSync(MERGED)) {
  const rl = readline.createInterface({ input: fs.createReadStream(MERGED), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const name = o.name_ja || o.name_en;
    if (!name || !Number.isFinite(o.lat) || !Number.isFinite(o.lon)) continue;
    const cats = uniq(o.categories || ["tourism"]);
    const desc =
      o.wikivoyage_ja_text || o.wikidata_desc_ja || o.wikivoyage_en_text || o.wikidata_desc_en;
    const a = o.address || {};
    push(
      baseRecord({
        id: o.id,
        name,
        lat: o.lat,
        lon: o.lon,
        cats,
        words: wordsFor(cats),
        props: {
          "name:en": o.name_en,
          opening_hours: o.opening_hours,
          website: o.website,
          "addr:city": a.city,
          "addr:neighbourhood": a.neighbourhood,
        },
        desc,
        source: desc ? "OSM + Wikidata/Wikivoyage" : "OpenStreetMap",
      }),
    );
  }
}

// 3) 映画館・劇場、買い物（デートプラン等で使う）
console.log("• theatre_cinema / shopping");
for (const f of readGeoJSON("theatre_cinema.geojson")) {
  const p = f.properties || {};
  const c = coords(f);
  const name = nameOf(p);
  if (!c || !name) continue;
  const cat = p.amenity === "cinema" ? "cinema" : "theatre";
  push(
    baseRecord({
      id: `osm:${p.osm_type}:${p.osm_id}`,
      name,
      lon: c[0],
      lat: c[1],
      cats: [cat],
      words: wordsFor([cat]),
      props: p,
      access: accessFromOsm(p),
      source: "OpenStreetMap",
    }),
  );
}
const SHOP_KEEP = new Set(["department_store", "mall", "gift", "confectionery", "books", "bakery"]);
for (const f of readGeoJSON("shopping.geojson")) {
  const p = f.properties || {};
  const c = coords(f);
  const name = nameOf(p);
  const shop = p.shop;
  if (!c || !name || !SHOP_KEEP.has(shop)) continue;
  push(
    baseRecord({
      id: `osm:${p.osm_type}:${p.osm_id}`,
      name,
      lon: c[0],
      lat: c[1],
      cats: [shop],
      words: wordsFor([shop]),
      props: p,
      access: accessFromOsm(p),
      source: "OpenStreetMap",
    }),
  );
}

// 4) 公衆トイレ・Wi-Fi（食べ歩き中の「この辺で休める場所」用）
console.log("• toilets_wifi");
for (const f of readGeoJSON("toilets_wifi.geojson")) {
  const p = f.properties || {};
  const c = coords(f);
  if (!c) continue;
  const isToilet = p.amenity === "toilets";
  const name = nameOf(p) || (isToilet ? "公衆トイレ" : "Wi-Fiスポット");
  push(
    baseRecord({
      id: `osm:${p.osm_type}:${p.osm_id}`,
      name,
      lon: c[0],
      lat: c[1],
      cats: [isToilet ? "toilets" : "facility"],
      words: wordsFor([isToilet ? "toilets" : "wifi"]),
      props: p,
      access: accessFromOsm(p),
      source: "OpenStreetMap",
    }),
  );
}

// 5) 駅（transit ルートの近似 + 地名解決に使う）
console.log("• railway_station.geojson");
const stations = [];
for (const f of readGeoJSON("railway_station.geojson")) {
  const p = f.properties || {};
  const c = coords(f);
  const name = nameOf(p);
  if (!c || !name) continue;
  const clean = name.replace(/駅$/, "");
  stations.push({
    name: clean,
    display: `${clean}駅`,
    lat: Math.round(c[1] * 1e6) / 1e6,
    lon: Math.round(c[0] * 1e6) / 1e6,
    operator: p.operator || p.network || null,
    subway: p.subway === "yes",
  });
  push(
    baseRecord({
      id: `osm:${p.osm_type}:${p.osm_id}`,
      name: `${clean}駅`,
      lon: c[0],
      lat: c[1],
      cats: ["station"],
      words: wordsFor(["station"]),
      props: p,
      access: accessFromOsm(p),
      source: "OpenStreetMap",
    }),
  );
}

// 6) 宿泊施設
//    区の旅館台帳（旅館業法の許可台帳＝一次情報。ただし緯度経度が空の行が4割ある）を主にして、
//    台帳を公開していない区（新宿・港など）を OSM で埋める。
console.log("• 宿泊施設（旅館台帳 + OSM）");
loadGeocoder(ADDR_REF);
let ryokanCount = 0;
let ryokanGeocoded = 0;
let ryokanMergedIntoOsm = 0;
for (const ward of fs.existsSync(WARD) ? fs.readdirSync(WARD) : []) {
  const dir = path.join(WARD, ward, "宿泊施設（旅館台帳）");
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".csv"))) {
    for (const [i, r] of readCsvObjects(path.join(dir, file)).entries()) {
      const name = cleanName(r["名称"]);
      if (!name) continue;
      const city = r["所在地_市区町村"] || ward;

      let lat = Number(r["緯度"]);
      let lon = Number(r["経度"]);
      let approx = false;
      if (!Number.isFinite(lat) || lat < 20) {
        const g = geocode(r["所在地_連結表記"], city);
        if (!g) continue;
        lat = g.lat;
        lon = g.lon;
        approx = true;
        ryokanGeocoded++;
      }

      const form = (r["営業形態"] || "").replace(/\s+/g, "");
      const cat = /簡易宿所|下宿/.test(form) ? "hostel" : "hotel";
      const permitted = (r["許可年月日"] || "").slice(0, 10);

      // OSM 側に同じ宿が居ることがある。ピンを二重に立てず、台帳側の情報を足すだけにする。
      // 座標が住所からの推定のときは建物からずれるので、少し広めに見る。
      const dup = findExisting(name, lat, lon, approx ? 350 : 200);
      if (dup) {
        relabel(dup, cat);
        if (!dup.source.includes("旅館台帳")) dup.source = `${dup.source} + ${ward} 宿泊施設（旅館台帳）`;
        const permitNote = `${form || "旅館業許可施設"}。${city}の旅館業許可台帳に登録あり${permitted ? `（許可 ${permitted}）` : ""}`;
        dup.desc = dup.desc ? `${dup.desc} / ${permitNote}`.slice(0, 400) : permitNote;
        ryokanMergedIntoOsm++;
        continue;
      }

      const rec = push(
        baseRecord({
          id: `ryokan:${r["全国地方公共団体コード"] || ward}:${i}`,
          name,
          lat,
          lon,
          cats: [cat],
          words: wordsFor([cat, /旅館/.test(form) ? "ryokan" : null]),
          props: {
            "addr:city": city,
            "addr:neighbourhood": r["所在地_町字"] || "",
            phone: r["電話番号"] || "",
          },
          desc: [
            form || "旅館業許可施設",
            `${city}が公開している旅館業法の許可台帳に載っている施設`,
            permitted ? `許可 ${permitted}` : null,
          ]
            .filter(Boolean)
            .join("。"),
          approx,
          source: `${ward} 宿泊施設（旅館台帳）`,
        }),
      );
      if (rec) ryokanCount++;
    }
  }
}
let osmHotels = 0;
let osmRelabeled = 0;
/** 宿泊として扱ってよい tourism 値。それ以外（例: information）は無視する。 */
const STAY_CATS = new Set([
  "hotel", "hostel", "guest_house", "apartment", "motel", "chalet", "camp_site", "love_hotel", "capsule_hotel",
]);
for (const f of readGeoJSON("accommodation.geojson")) {
  const p = f.properties || {};
  const c = coords(f);
  const name = nameOf(p);
  if (!c || !name) continue;
  const cat = STAY_CATS.has(p.tourism) ? p.tourism : "hotel";

  // 同じ宿がすでに居るなら、消すのではなく直す。
  //   - 旅館台帳（一次情報）とぶつかった → 台帳側を残し、OSM のバリアフリータグだけ足す
  //   - tokyo_spots.jsonl が「観光スポット」として持っていた → 宿泊カテゴリに貼り替える
  const existing = findExisting(name, c[1], c[0], 250);
  if (existing) {
    const wasGeneric = ["tourism", "attraction"].includes(existing.cats[0]);
    if (wasGeneric) {
      relabel(existing, cat);
      osmRelabeled++;
    }
    const osmAccess = accessFromOsm(p);
    if (osmAccess) applyAccess(existing, osmAccess, null);
    continue;
  }
  const rec = push(
    baseRecord({
      id: `osm:${p.osm_type}:${p.osm_id}`,
      name,
      lon: c[0],
      lat: c[1],
      cats: [cat],
      words: wordsFor([cat]),
      props: p,
      access: accessFromOsm(p),
      source: "OpenStreetMap",
    }),
  );
  if (rec) osmHotels++;
}

// 7) 東京都「だれでも東京」（バリアフリー調査）
//    段差の高さ cm まで載っている代わりに約900件しかない。
//    既存スポットに見つかれば情報を足し、見つからなければ新規に立てる。
console.log("• だれでも東京（東京都デジタルサービス局）");
const DAREDEMO = path.join(
  WARD,
  "東京都デジタルサービス局",
  "宿泊施設等の施設情報ポータルサイト「だれでも東京」",
);
/**
 * 施設名からカテゴリを推す。
 * 「だれでも東京」は表がバリアフリー調査の実施単位で切られているので、
 * ファイル名（＝05_公園）が施設の実態と合わないことがある（例: 神田神社が公園の表に載る）。
 * 名前で分かるものは名前を優先する。
 */
const NAME_CAT_RULES = [
  [/神社|大社|八幡宮|天満宮|稲荷|[^書]寺$|寺院|大師|不動尊|観音/, "worship"],
  [/美術館|博物館|ミュージアム|記念館|資料館|科学館/, "museum"],
  [/水族館/, "aquarium"],
  [/動物園/, "zoo"],
  [/植物園|庭園|公園|御苑/, "park"],
  [/ホテル|旅館|イン$|ホステル|ゲストハウス/, "hotel"],
  [/駅$/, "station"],
  [/劇場|座$|ホール|会館/, "theatre"],
  [/空港|ターミナル/, "facility"],
  [/温泉|銭湯|健康ランド/, "onsen"],
  [/図書館/, "facility"],
  [/百貨店|デパート/, "department_store"],
  [/モール|プラザ|パルコ|ルミネ|アトレ|マルイ/, "mall"],
];

function guessCat(name, fallback) {
  for (const [re, cat] of NAME_CAT_RULES) {
    if (re.test(name)) return cat;
  }
  return fallback;
}

/** ファイル名 → そのファイルに載っている施設の種別 */
const DAREDEMO_CATS = {
  "00_宿泊施設": "hotel",
  "01_ショッピング": "mall",
  "02_レジャー": "attraction",
  "03_飲食": "restaurant",
  "04_交通": "station",
  "05_公園": "park",
  "06_公共施設": "facility",
};
let daredemoMerged = 0;
let daredemoNew = 0;
let daredemoDropped = 0;
for (const file of fs.existsSync(DAREDEMO) ? fs.readdirSync(DAREDEMO) : []) {
  if (!file.endsWith(".csv")) continue;
  const fileCat = DAREDEMO_CATS[file.replace(/\.csv$/, "")] || "facility";
  for (const [i, r] of readCsvObjects(path.join(DAREDEMO, file)).entries()) {
    const rawName = cleanName(r["施設名"]);
    if (!rawName) continue;
    const cat = guessCat(rawName, fileCat);

    const access = accessFromDaredemo(r);
    if (!access) continue;

    // 駅だけは別扱い。この表の駅の座標は壊れていて（JR の110行が同一の誤った点）、
    // そのまま地図に置くと嘘になる。名前で既存の駅レコードに寄せ、引けなければ捨てる。
    // 同じ駅が事業者ごとに複数行あるので、見つかった駅レコード全部に足す。
    if (cat === "station") {
      const stations = findStationsByName(rawName);
      if (!stations.length) {
        daredemoDropped++;
        continue;
      }
      for (const st of stations) applyAccess(st, access, "東京都「だれでも東京」");
      daredemoMerged++;
      continue;
    }

    const lat = Number(r["緯度"] || r["緯度_加工"]);
    const lon = Number(r["経度"] || r["経度_加工"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      daredemoDropped++;
      continue;
    }

    const existing = findExisting(rawName, lat, lon, 1200);
    if (existing) {
      applyAccess(existing, access, "東京都「だれでも東京」");
      daredemoMerged++;
      continue;
    }
    const rec = push(
      baseRecord({
        id: `daredemo:${file.slice(0, 2)}:${i}`,
        name: rawName,
        lat,
        lon,
        cats: [cat],
        words: wordsFor([cat]),
        props: {
          "addr:city": r["市区町村名"] || "",
          "addr:neighbourhood": r["町丁目名"] || "",
          phone: r["電話番号"] || "",
          website: r["施設URL"] || "",
        },
        access,
        desc: `東京都のバリアフリー調査（${r["調査_年月日"] || "調査年月日不明"}時点）に載っている施設。`,
        source: "東京都「だれでも東京」",
      }),
    );
    if (rec) daredemoNew++;
  }
}

// 8) 東京都 飲食店バリアフリー情報（210店）
//    座標が無く住所しか無いので、位置参照情報で街区レベルまで落とす。
//    OSM に同名の店がある確率は低い（商業ビルの中の店が多い）ので、ほとんどは新規になる。
console.log("• 東京都内の飲食店のバリアフリー情報（東京都産業労働局）");
const RESTAURANT_BF = path.join(
  WARD,
  "東京都産業労働局",
  "東京都内の飲食店のバリアフリー情報",
  "00_東京都内の飲食店のバリアフリー情報.csv",
);
let bfMerged = 0;
let bfNew = 0;
let bfSkipped = 0;
if (fs.existsSync(RESTAURANT_BF)) {
  for (const [i, r] of readCsvObjects(RESTAURANT_BF).entries()) {
    const name = cleanName(r["店名"]);
    if (!name) continue;
    const g = geocode(r["住所"]);
    if (!g) {
      bfSkipped++;
      continue;
    }
    const access = accessFromRestaurantCsv(r);
    // 住所からの推定座標なので、街区ひとつ分ぐらいのズレは許容する
    const existing = findExisting(name, g.lat, g.lon, 800);
    if (existing) {
      applyAccess(existing, access, "東京都 飲食店バリアフリー情報");
      bfMerged++;
      continue;
    }
    // 営業時間は「11:00～23:00」のような自由記述で opening_hours の記法ではない。
    // isOpenNow に食わせると誤判定するので hours には入れず、説明文に回す。
    const rec = push(
      baseRecord({
        id: `bf-food:${i}`,
        name,
        lat: g.lat,
        lon: g.lon,
        cats: ["restaurant"],
        words: wordsFor(["restaurant"]),
        props: {
          "addr:city": g.city,
          "addr:neighbourhood": g.oaza,
          phone: r["店舗電話番号"] || "",
          website: r["店舗URL"] || "",
        },
        access,
        desc: [
          "東京都のバリアフリー調査に載っている飲食店。",
          r["営業時間"] ? `営業時間 ${r["営業時間"]}` : null,
          r["定休日"] ? `定休日 ${r["定休日"]}` : null,
          r["アクセス"] || null,
        ]
          .filter(Boolean)
          .join(" / "),
        approx: g.precision !== "street_block",
        source: "東京都 飲食店バリアフリー情報",
      }),
    );
    if (rec) bfNew++;
  }
}

// 9) エリア辞書：駅名 + 市区町村 + 町名の重心
const areas = new Map();
function addArea(name, lat, lon) {
  if (!name) return;
  const k = normalize(name);
  if (!k) return;
  const cur = areas.get(k) || { name, lat: 0, lon: 0, n: 0 };
  cur.lat += lat;
  cur.lon += lon;
  cur.n += 1;
  areas.set(k, cur);
}
for (const s of stations) {
  addArea(s.name, s.lat, s.lon);
  addArea(s.display, s.lat, s.lon);
}
for (const r of records) {
  if (r.city) addArea(r.city, r.lat, r.lon);
  if (r.hood) addArea(r.hood, r.lat, r.lon);
}
addArea("東京", 35.6812, 139.7671);
addArea("東京駅", 35.6812, 139.7671);
addArea("都内", 35.6812, 139.7671);

const areaOut = {};
for (const [k, v] of areas) {
  areaOut[k] = {
    name: v.name,
    lat: Math.round((v.lat / v.n) * 1e6) / 1e6,
    lon: Math.round((v.lon / v.n) * 1e6) / 1e6,
  };
}

// ------------------------------------------------------------------------ 出力
fs.mkdirSync(OUT_DIR, { recursive: true });
const poiText = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
fs.writeFileSync(path.join(OUT_DIR, "poi.jsonl"), poiText);
// .gz の方をリポジトリに載せる（非圧縮24MB → 約3MB）。gitignore は poi.jsonl だけを除外している。
fs.writeFileSync(path.join(OUT_DIR, "poi.jsonl.gz"), zlib.gzipSync(poiText, { level: 9 }));
fs.writeFileSync(path.join(OUT_DIR, "areas.json"), JSON.stringify(areaOut));
fs.writeFileSync(path.join(OUT_DIR, "stations.json"), JSON.stringify(stations));

const byCat = {};
for (const r of records) byCat[r.cats[0]] = (byCat[r.cats[0]] || 0) + 1;
const withAccess = records.filter((r) => r.access).length;
console.log(`\n✓ poi.jsonl      ${records.length} 件`);
console.log(
  `✓ poi.jsonl.gz   ${(fs.statSync(path.join(OUT_DIR, "poi.jsonl.gz")).size / 1048576).toFixed(1)} MB（これをコミットする）`,
);
console.log(`✓ areas.json     ${Object.keys(areaOut).length} 地名`);
console.log(`✓ stations.json  ${stations.length} 駅`);
console.log(
  "  内訳:",
  Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([k, v]) => `${k}:${v}`)
    .join(", "),
);
console.log(
  `\n  宿泊     旅館台帳 ${ryokanCount}件（うち住所から座標化 ${ryokanGeocoded}件）` +
    ` / 既存スポットに統合 ${ryokanMergedIntoOsm}件` +
    ` / OSM 新規 ${osmHotels}件・観光スポット扱いだった ${osmRelabeled}件を宿泊に再分類`,
);
console.log(
  `  バリアフリー だれでも東京 ${daredemoMerged}件を既存に統合 / ${daredemoNew}件を新規追加` +
    ` / ${daredemoDropped}件は座標が無い・壊れているため除外`,
);
console.log(
  `           飲食店バリアフリー ${bfMerged}件を既存に統合 / ${bfNew}件を新規追加 / ${bfSkipped}件は住所を解決できず除外`,
);
console.log(`           access を持つスポット 合計 ${withAccess}件`);
