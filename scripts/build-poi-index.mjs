#!/usr/bin/env node
/**
 * オープンデータ → POI 検索インデックス
 *
 * 入力（すべて hackathon_2026/data 配下、既存のオープンデータ）
 *   - 03_geospatial/openstreetmap/*.geojson          (OSM / ODbL)
 *   - 08_merged_tokyo_spots/tokyo_spots.jsonl        (OSM + Wikidata + Wikivoyage)
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA_SRC = path.resolve(ROOT, "..", "data");
const OSM = path.join(DATA_SRC, "03_geospatial", "openstreetmap");
const MERGED = path.join(DATA_SRC, "08_merged_tokyo_spots", "tokyo_spots.jsonl");
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

function baseRecord({ id, name, lat, lon, cats, words, props = {}, desc = null, source }) {
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

function push(rec) {
  if (!rec || !rec.name || !Number.isFinite(rec.lat) || !Number.isFinite(rec.lon)) return;
  const key = `${rec.name}@${rec.lat.toFixed(4)},${rec.lon.toFixed(4)}`;
  if (seen.has(key)) return;
  seen.add(key);
  records.push(rec);
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
      source: "OpenStreetMap",
    }),
  );
}

// 6) エリア辞書：駅名 + 市区町村 + 町名の重心
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
    .slice(0, 12)
    .map(([k, v]) => `${k}:${v}`)
    .join(", "),
);
