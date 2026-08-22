/**
 * 「だれが実際にその場所を使えるか」を、出所の違う表から同じ形に揃える。
 *
 * 出所は3つ。粒度がまるで違うので、共通項だけを取る:
 *   - OpenStreetMap のタグ         … 広く薄い（6.6万件のうち約6千件に何か入っている）
 *   - 東京都「だれでも東京」        … 狭く極めて厚い（段差の高さ cm まである）
 *   - 東京都 飲食店バリアフリー情報  … 飲食店210件。設備に加えて食事制限対応がある
 *
 * null と false は違う。「無い」と「調べていない」を混ぜると、
 * データが薄い店ほど条件検索から漏れて不利になる。
 */
import { num, yesNo } from "./opendata.mjs";

/** 値が入っているキーだけ残す（poi.jsonl を無駄に太らせないため） */
function compact(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** OSM のバリアフリー系タグ。ほとんどの POI では null が返る。 */
export function accessFromOsm(p) {
  const wheelchair = ["yes", "limited", "no"].includes(p.wheelchair) ? p.wheelchair : null;
  const a = compact({
    wheelchair,
    step_free: wheelchair === "yes" ? true : null,
    accessible_toilet:
      p["toilets:wheelchair"] === "yes" || p["toilets:wheelchair"] === "designated"
        ? true
        : p["toilets:wheelchair"] === "no"
          ? false
          : null,
    changing_table: yesNo(p.changing_table) ?? (p.changing_table === "room" ? true : null),
    free_toilet: p.amenity === "toilets" && p.fee === "no" ? true : null,
    unisex_toilet: p.amenity === "toilets" ? yesNo(p.unisex) : null,
  });
  if (a) a.src = "OpenStreetMap";
  return a;
}

/**
 * 東京都「だれでも東京」（宿泊・ショッピング・レジャー・飲食・交通・公園・公共施設）。
 * 表ごとに列名が微妙に違う（宿泊だけ「車椅子使用者対応トイレの設置有無」）ので
 * 候補名を順に見る。
 */
export function accessFromDaredemo(r) {
  const pick = (...names) => {
    for (const n of names) if (r[n] !== undefined && r[n] !== "") return r[n];
    return "";
  };
  const stepFree = yesNo(pick("施設出入口の段差の有無"));
  const accessibleToilet = yesNo(pick("だれでもトイレの設置有無", "車椅子使用者対応トイレの設置有無"));
  const slope = yesNo(pick("施設出入口付近スロープの有無"));

  return compact({
    // 「段差の有無 = 無」が段差なし。真偽が反転するので取り違えないこと。
    step_free: stepFree === null ? null : !stepFree,
    step_height_cm: num(pick("段差の高さ(cm)")),
    entrance_width_cm: num(pick("施設出入口の間口有効寸法(cm)")),
    slope,
    auto_door: yesNo(pick("自動ドアの有無")),
    elevator: yesNo(pick("エレベーターの有無")),
    accessible_toilet: accessibleToilet,
    accessible_toilet_count: num(pick("施設内合計設置数")),
    ostomate: yesNo(pick("オストメイト対応トイレの有無")),
    changing_table: yesNo(pick("施設内おむつ交換台の有無")),
    nursing_room: yesNo(pick("授乳室の有無")),
    tactile_paving: yesNo(pick("点字ブロックの有無")),
    braille_map: yesNo(pick("点字や浮き出し文字による館内案内マップの有無")),
    sign_language: yesNo(pick("スタッフの手話対応の可否")),
    writing_support: yesNo(pick("筆談対応用備品の有無", "スタッフの筆談対応の可否")),
    wheelchair_rental: yesNo(pick("車いすの貸出の可否")),
    stroller_rental: yesNo(pick("ベビーカーの貸出の可否")),
    assistance_dog: yesNo(pick("補助犬専用トイレの有無", "補助犬のマットの有無")),
    accessible_parking: yesNo(pick("車いす専用駐車場の有無")),
    flash_bell: yesNo(pick("フラッシュベル（聴覚障害者用アラートシステム）の貸出の可否")),
    // 段差なし＋だれでもトイレが揃っていれば車椅子で使えると見なす。
    // スロープだけの場合は limited（介助が要るかもしれない）に落とす。
    wheelchair:
      stepFree === false && accessibleToilet === true
        ? "yes"
        : stepFree === false || slope === true
          ? "limited"
          : stepFree === true && slope !== true
            ? "no"
            : null,
    src: "東京都「だれでも東京」",
  });
}

/** 東京都産業労働局 東京都内の飲食店のバリアフリー情報（210店） */
export function accessFromRestaurantCsv(r) {
  const wideDoor = yesNo(r["入口幅が80cm以上である"]);
  const flat = yesNo(r["入口の移動経路は平坦または段差が2cm以下である"]);
  const roomToMove = yesNo(r["店舗内は車椅子での移動が可能である"]);
  return compact({
    step_free: flat,
    entrance_width_cm: wideDoor === true ? 80 : null, // 「80cm以上」しか分からないので下限値
    wheelchair:
      flat === true && roomToMove === true ? "yes" : flat === true || roomToMove === true ? "limited" : null,
    movable_chairs: yesNo(r["店舗内の椅子は移動可能である"]),
    table_clearance: yesNo(r["テーブル下にスペースがある（高さ65cm×幅70cm×奥行45cm程度）"]),
    accessible_toilet: yesNo(
      r["車椅子使用者対応トイレがある（施設内の他フロアを含む）またはオストメイトがある"],
    ),
    photo_menu: yesNo(r["写真メニューがある"]),
    multilingual_menu: yesNo(r["英語等外国語のメニューがある"]),
    braille_menu: yesNo(r["点字表記のメニューがある"]),
    writing_support: yesNo(r["筆談によるコミュニケーションがある"]),
    sign_language: yesNo(r["手話のできるスタッフがいる"]),
    allergy: yesNo(r["事前申請によるアレルギー対応が可能"]),
    vegetarian: yesNo(r["事前申請によるベジタリアンまたはヴィーガン対応が可能"]),
    halal: yesNo(r["事前申請によるハラール対応が可能"]),
    src: "東京都 飲食店バリアフリー情報",
  });
}

/**
 * 出所の違う情報を1件にまとめる。
 * 都のバリアフリー調査は OSM のタグより桁違いに詳しいので、衝突したら後勝ちにする。
 */
export function mergeAccess(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === null || v === undefined || v === "") continue;
    if (k === "src") {
      // 同じ調査が複数行に分かれている（駅の事業者別など）ので、同じ出典を並べない
      out.src = !out.src ? v : out.src.includes(v) ? out.src : `${out.src} + ${v}`;
    } else out[k] = v;
  }
  return out;
}

/**
 * access → 日本語の検索語。
 * これが無いと「バリアフリー」「おむつ替え」のような素直な言い方で引けない。
 */
const WORDS = {
  step_free: ["段差なし", "バリアフリー", "フラット"],
  slope: ["スロープ", "バリアフリー"],
  elevator: ["エレベーター"],
  auto_door: ["自動ドア"],
  accessible_toilet: ["多目的トイレ", "だれでもトイレ", "車椅子トイレ", "車いすトイレ", "バリアフリートイレ"],
  ostomate: ["オストメイト"],
  changing_table: ["おむつ替え", "おむつ交換", "ベビーベッド", "子連れ"],
  nursing_room: ["授乳室", "子連れ", "赤ちゃん"],
  tactile_paving: ["点字ブロック", "視覚障害"],
  braille_map: ["点字", "視覚障害"],
  braille_menu: ["点字メニュー", "点字", "視覚障害"],
  sign_language: ["手話", "聴覚障害"],
  writing_support: ["筆談", "聴覚障害"],
  flash_bell: ["フラッシュベル", "聴覚障害"],
  wheelchair_rental: ["車椅子貸出", "車いす貸出"],
  stroller_rental: ["ベビーカー貸出", "子連れ"],
  assistance_dog: ["補助犬", "盲導犬", "介助犬"],
  accessible_parking: ["車椅子駐車場", "身障者用駐車場"],
  photo_menu: ["写真メニュー"],
  multilingual_menu: ["英語メニュー", "外国語メニュー", "多言語"],
  allergy: ["アレルギー対応", "アレルギー"],
  vegetarian: ["ベジタリアン", "ヴィーガン", "ビーガン"],
  halal: ["ハラール", "ハラル"],
  free_toilet: ["無料トイレ"],
  movable_chairs: ["椅子可動"],
  table_clearance: ["テーブル下スペース"],
};

export function accessWords(access) {
  if (!access) return [];
  const out = [];
  if (access.wheelchair === "yes") out.push("車椅子", "車いす", "バリアフリー", "wheelchair");
  else if (access.wheelchair === "limited") out.push("車椅子", "車いす", "一部バリアフリー");
  for (const [k, words] of Object.entries(WORDS)) {
    if (access[k] === true) out.push(...words);
  }
  return [...new Set(out)];
}
