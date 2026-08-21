"use client";

import maplibregl, { type LngLatBoundsLike, type Map as MLMap } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { Itinerary, LatLng, Place, RouteResult } from "@/lib/types";

/**
 * 上ペインの地図。
 *
 * 地図は「共有状態の投影」でしかない（roadmap §1）。LLM は地図を操作せず、
 * search_places / get_route / save_itinerary の結果がそのままここに流れてくる。
 *
 * タイル: OpenFreeMap（OpenMapTiles スキーマのベクタタイル / OSM 由来・APIキー不要・無料）
 * ラスタではなくベクタなので、ズームしてもラベルが潰れない。
 */

const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

/** ライトなベースマップの上でも沈まない濃さに揃える */
const MODE_COLOR: Record<string, string> = {
  walk: "#1a73e8",
  transit: "#188038",
  taxi: "#e8710a",
  car: "#c5221f",
};

const PLACE_PIN = "#ea4335"; // Google マップでおなじみの赤
const ITIN_PIN = "#f9ab00"; // 旅程に入ったものは琥珀色

/**
 * ズームに応じた線幅。固定値だと引きで太すぎ、寄りで細すぎる。
 *
 * zoom 式は interpolate / step の最上位にしか置けない（["*", <interpolate>, 2] は
 * MapLibre に弾かれてレイヤごと無視される）ので、倍率は各停で先に掛けておく。
 */
function lineWidth(scale = 1, pad = 0): maplibregl.ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    10,
    3 * scale + pad,
    14,
    5 * scale + pad,
    18,
    8 * scale + pad,
  ];
}

/**
 * 徒歩は「丸ドットの点線」で描く。dasharray の単位は線幅なので、
 * 縁取りと本体で同じ間隔にするには線幅の比で割る必要がある（下の 4.5 / 8 がそれ）。
 * そのため徒歩だけは線幅を固定にしている。
 */
const WALK_W = 4.5;
const WALK_HALO_W = 8;
const WALK_DASH: [number, number] = [0, 1.8];
const WALK_HALO_DASH: [number, number] = [0, (1.8 * WALK_W) / WALK_HALO_W];

/** ルートの描き出しアニメーション（ms） */
const DRAW_MS = 750;
/** コメット（進行方向のパルス）の周期（ms）と尾の長さ（全長比） */
const PULSE_MS = 3000;
const PULSE_TAIL = 0.14;

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/**
 * 雫型ピン。marker の anchor: "bottom" と組み合わせて、先端が座標を指すようにする。
 * 白い縁取りを付けているのは、道路・建物・水域のどの上に載っても輪郭が消えないようにするため。
 */
function pinSvg(fill: string, label?: string): string {
  const inner = label
    ? `<circle cx="12" cy="12" r="7.2" fill="#fff"/>` +
      `<text x="12" y="12" text-anchor="middle" dominant-baseline="central"` +
      ` font-family="system-ui, -apple-system, sans-serif"` +
      ` font-size="${label.length > 1 ? 10 : 12}" font-weight="700" fill="#20262e">${label}</text>`
    : `<circle cx="12" cy="12" r="4.2" fill="#fff"/>`;
  return (
    `<svg width="26" height="36" viewBox="-1 -1 26 36" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="M12 0C5.373 0 0 5.373 0 12c0 8.4 10.2 20.2 11.06 21.18a1.25 1.25 0 0 0 1.88 0C13.8 32.2 24 20.4 24 12 24 5.373 18.627 0 12 0z"` +
    ` fill="${fill}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>` +
    inner +
    `</svg>`
  );
}

// --------------------------------------------------------------- 線形ユーティリティ

/** 緯度経度の平面近似での距離（m）。描画用の按分なのでこれで十分。 */
function segMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const p = Math.PI / 180;
  const dLat = (b[1] - a[1]) * p;
  const dLng = (b[0] - a[0]) * p;
  const la = ((a[1] + b[1]) / 2) * p;
  return R * Math.hypot(dLng * Math.cos(la), dLat);
}

type Chain = { pts: [number, number][]; cum: number[]; total: number };

function chainOf(pts: [number, number][]): Chain {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + segMeters(pts[i - 1], pts[i]));
  return { pts, cum, total: cum[cum.length - 1] ?? 0 };
}

function lerp(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** chain の [from, to] メートル区間を切り出す */
function slice(chain: Chain, from: number, to: number): [number, number][] {
  const { pts, cum, total } = chain;
  if (pts.length < 2 || total <= 0) return [];
  const a = Math.max(0, Math.min(from, total));
  const b = Math.max(0, Math.min(to, total));
  if (b - a <= 0.01) return [];

  const out: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) {
    const s = cum[i - 1];
    const e = cum[i];
    if (e < a || s > b) continue;
    const segLen = e - s || 1;
    if (out.length === 0) out.push(lerp(pts[i - 1], pts[i], (a - s) / segLen));
    if (e <= b) out.push(pts[i]);
    else out.push(lerp(pts[i - 1], pts[i], (b - s) / segLen));
  }
  return out.length >= 2 ? out : [];
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

type Entry = { marker: maplibregl.Marker; inner: HTMLElement; html: string; lngLat: [number, number] };

type Props = {
  places: Place[];
  route: RouteResult | null;
  itinerary: Itinerary | null;
  location: LatLng | null;
  /** 選択中の place_id（候補パネルと共有する） */
  selectedId: string | null;
  onSelect: (placeId: string | null) => void;
  /** 候補パネルが地図に被さっている幅。fitBounds の右余白に使う。 */
  padRight: number;
};

export default function MapPane({
  places,
  route,
  itinerary,
  location,
  selectedId,
  onSelect,
  padRight,
}: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const entries = useRef<Map<string, Entry>>(new Map());
  const popup = useRef<maplibregl.Popup | null>(null);
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const anim = useRef<number | null>(null);

  // --- 初期化 ---------------------------------------------------------------
  useEffect(() => {
    if (!holder.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: holder.current,
      style: MAP_STYLE,
      center: [139.7671, 35.6812], // 東京駅
      zoom: 12.2,
      attributionControl: false,
    });
    // 右上は候補パネルが被さるので、ズームは左下に置く
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
    mapRef.current = map;

    // ピンの選択に連動して開閉する共有ポップアップ（マーカーごとには持たせない）
    popup.current = new maplibregl.Popup({ offset: 30, closeButton: false, closeOnClick: false });

    map.on("load", () => {
      map.addSource("route", { type: "geojson", data: EMPTY });
      map.addSource("route-pulse", { type: "geojson", data: EMPTY, lineMetrics: true });
      map.addSource("route-nodes", { type: "geojson", data: EMPTY });

      /**
       * ルートの挿入位置。
       *
       * 「最初の symbol レイヤの下」に入れると、Liberty では road_one_way_arrow
       * （一方通行の矢印）が最初の symbol なので、その下＝ bridge_* 20枚と building
       * より下に潜ってしまう。首都高や高架がルートを塗り潰していたのはこれが原因。
       * text-field を持つ最初の symbol（= 本当のラベル開始点）を探せば、
       * 橋・建物より上、かつ地名ラベルより下に入る。
       */
      const layers = map.getStyle().layers ?? [];
      const firstLabel =
        layers.find(
          (l) => l.type === "symbol" && (l.layout as Record<string, unknown> | undefined)?.["text-field"],
        )?.id ?? layers.find((l) => l.type === "symbol")?.id;

      const color: maplibregl.ExpressionSpecification = [
        "coalesce",
        ["get", "color"],
        MODE_COLOR.walk,
      ];
      const isWalk: maplibregl.FilterSpecification = ["==", ["get", "walk"], true];
      const notWalk: maplibregl.FilterSpecification = ["!=", ["get", "walk"], true];

      // 発光。ダークな UI 上でもルートが浮き上がる。
      map.addLayer(
        {
          id: "route-glow",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": color,
            "line-width": lineWidth(2.4),
            "line-blur": 8,
            "line-opacity": 0.35,
          },
        },
        firstLabel,
      );
      // 車・徒歩以外の実線区間：白い縁取り + 本体
      map.addLayer(
        {
          id: "route-casing",
          type: "line",
          source: "route",
          filter: notWalk,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#ffffff",
            "line-width": lineWidth(1, 5),
            "line-opacity": 0.92,
          },
        },
        firstLabel,
      );
      map.addLayer(
        {
          id: "route-line",
          type: "line",
          source: "route",
          filter: notWalk,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": color, "line-width": lineWidth() },
        },
        firstLabel,
      );
      // 徒歩区間：丸ドットの点線
      map.addLayer(
        {
          id: "route-walk-halo",
          type: "line",
          source: "route",
          filter: isWalk,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": "#ffffff",
            "line-width": WALK_HALO_W,
            "line-dasharray": WALK_HALO_DASH,
            "line-opacity": 0.9,
          },
        },
        firstLabel,
      );
      map.addLayer(
        {
          id: "route-walk",
          type: "line",
          source: "route",
          filter: isWalk,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": color,
            "line-width": WALK_W,
            "line-dasharray": WALK_DASH,
          },
        },
        firstLabel,
      );
      /**
       * 進行方向に流れる光。尾に向かって透明にする（line-gradient は lineMetrics 必須）。
       * 薄いハローと細い芯の2枚重ね。1枚だと路線カラーに埋もれて見えない。
       */
      map.addLayer(
        {
          id: "route-pulse-halo",
          type: "line",
          source: "route-pulse",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-width": lineWidth(2.1),
            "line-blur": 5,
            "line-gradient": [
              "interpolate",
              ["linear"],
              ["line-progress"],
              0,
              "rgba(255,255,255,0)",
              0.6,
              "rgba(255,255,255,0.25)",
              1,
              "rgba(255,255,255,0.85)",
            ],
          },
        },
        firstLabel,
      );
      map.addLayer(
        {
          id: "route-pulse",
          type: "line",
          source: "route-pulse",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-width": lineWidth(0.62),
            "line-blur": 0.6,
            "line-gradient": [
              "interpolate",
              ["linear"],
              ["line-progress"],
              0,
              "rgba(255,255,255,0)",
              0.7,
              "rgba(255,255,255,0.55)",
              0.92,
              "rgba(255,255,255,1)",
              1,
              "rgba(255,255,255,1)",
            ],
          },
        },
        firstLabel,
      );
      // 乗換駅・起終点
      map.addLayer(
        {
          id: "route-nodes",
          type: "circle",
          source: "route-nodes",
          paint: {
            "circle-radius": ["case", ["==", ["get", "kind"], "end"], 6.5, 5],
            "circle-color": "#ffffff",
            "circle-stroke-width": 2.6,
            "circle-stroke-color": ["coalesce", ["get", "color"], "#5f6b7a"],
          },
        },
        firstLabel,
      );

      ready.current = true;
    });

    // 地図の余白をクリックしたら選択解除
    map.on("click", () => onSelect(null));

    // ペイン高さ・サイドリストの出入りで幅が変わったら resize（roadmap §1.5-2）
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(holder.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      ready.current = false;
      entries.current.clear();
    };
    // onSelect は page 側で useCallback 済み（ここで再初期化させない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 現在地 ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !location) return;
    if (!meMarker.current) {
      const el = document.createElement("div");
      el.className = "pin-me";
      meMarker.current = new maplibregl.Marker({ element: el }).setLngLat([location.lng, location.lat]).addTo(map);
    } else {
      meMarker.current.setLngLat([location.lng, location.lat]);
    }
  }, [location]);

  // --- ピン（検索結果 + 旅程） ------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const e of entries.current.values()) e.marker.remove();
    entries.current.clear();

    const add = (id: string, lngLat: [number, number], svg: string, html: string, cls: string) => {
      // maplibre は marker の element 自体に transform を当てるので、
      // 拡大用の transform は内側の要素に分けて持たせる。
      const wrap = document.createElement("div");
      wrap.className = "pin-wrap";
      const inner = document.createElement("div");
      inner.className = cls;
      inner.innerHTML = svg;
      wrap.appendChild(inner);
      wrap.addEventListener("click", (ev) => {
        ev.stopPropagation(); // 地図クリック（＝選択解除）に伝播させない
        onSelect(id);
      });
      const marker = new maplibregl.Marker({ element: wrap, anchor: "bottom" })
        .setLngLat(lngLat)
        .addTo(map);
      entries.current.set(id, { marker, inner, html, lngLat });
    };

    const itinItems = itinerary?.days.flatMap((d) => d.items) ?? [];
    const itinIds = new Set(itinItems.map((i) => i.place_id));

    // 検索結果：赤いピン（旅程に入っているものは番号ピン側で描くので除外）
    for (const p of places) {
      if (itinIds.has(p.place_id)) continue;
      add(
        p.place_id,
        [p.lng, p.lat],
        pinSvg(PLACE_PIN),
        popupHtml(p.name, [
          p.category,
          p.address ?? "",
          p.is_open_now === true ? "営業中" : p.is_open_now === false ? "営業時間外" : "",
          p.opening_hours ?? "",
          p.description ?? "",
        ]),
        "pin-place",
      );
    }

    // 旅程：番号つきの琥珀ピン（roadmap §5 原則2「旅程に入っているかで描き分ける」）
    itinItems.forEach((item, i) => {
      add(
        item.place_id,
        [item.lng, item.lat],
        pinSvg(ITIN_PIN, String(i + 1)),
        popupHtml(`${i + 1}. ${item.name}`, [
          item.start_time ? `${item.start_time}〜` : "",
          item.duration_min ? `滞在 ${item.duration_min}分` : "",
          item.note ?? "",
        ]),
        "pin-place pin-itin",
      );
    });
  }, [places, itinerary, onSelect]);

  // --- 選択の反映（拡大 + 前面 + ポップアップ） --------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const pop = popup.current;
    if (!map || !pop) return;

    for (const [id, e] of entries.current) {
      const on = id === selectedId;
      e.inner.classList.toggle("selected", on);
      (e.marker.getElement() as HTMLElement).style.zIndex = on ? "3" : "";
    }

    const sel = selectedId ? entries.current.get(selectedId) : null;
    if (!sel) {
      pop.remove();
      return;
    }
    pop.setLngLat(sel.lngLat).setHTML(sel.html).addTo(map);
    // 画面外に居るときだけ寄せる。見えているものを動かすと視線を失うので動かさない。
    if (!map.getBounds().contains(sel.lngLat)) {
      map.easeTo({ center: sel.lngLat, duration: 500 });
    }
  }, [selectedId, places, itinerary]);

  // --- ルート（区間ごとの描き分け + 描き出し + コメット） -------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const stop = () => {
      if (anim.current !== null) cancelAnimationFrame(anim.current);
      anim.current = null;
    };

    const apply = () => {
      const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
      const pulseSrc = map.getSource("route-pulse") as maplibregl.GeoJSONSource | undefined;
      const nodeSrc = map.getSource("route-nodes") as maplibregl.GeoJSONSource | undefined;
      if (!src || !pulseSrc || !nodeSrc) return;

      stop();
      if (!route) {
        src.setData(EMPTY);
        pulseSrc.setData(EMPTY);
        nodeSrc.setData(EMPTY);
        return;
      }

      // leg が線形を持っていない古い形にも耐える（ルート全体を1区間として扱う）
      const legs =
        route.legs.length > 0 && route.legs.some((l) => (l.polyline?.length ?? 0) >= 2)
          ? route.legs.filter((l) => (l.polyline?.length ?? 0) >= 2)
          : [
              {
                from: "",
                to: "",
                mode: route.mode,
                distance_m: route.distance_m,
                duration_s: route.duration_s,
                note: null,
                polyline: route.polyline,
                operator: null,
                line: null,
                color: null,
              },
            ];

      // leg ごとに chain を作り、ルート全体での開始距離を持たせる
      let offset = 0;
      const parts = legs.map((l) => {
        const chain = chainOf(l.polyline as [number, number][]);
        const start = offset;
        offset += chain.total;
        return {
          chain,
          start,
          walk: l.mode === "walk",
          color: l.color ?? MODE_COLOR[l.mode] ?? MODE_COLOR.walk,
          mode: l.mode,
          label: l.line ?? null,
        };
      });
      const total = offset;

      // 全体を繋いだ1本（コメットが leg 境界で途切れないように）
      const whole: [number, number][] = [];
      for (const p of parts) {
        if (whole.length === 0) whole.push(...p.chain.pts);
        else whole.push(...p.chain.pts.slice(1));
      }
      const wholeChain = chainOf(whole);

      const featuresUpTo = (d: number): GeoJSON.FeatureCollection => ({
        type: "FeatureCollection",
        features: parts.flatMap((p) => {
          const cut = Math.min(p.chain.total, d - p.start);
          if (cut <= 0) return [];
          const coords = cut >= p.chain.total ? p.chain.pts : slice(p.chain, 0, cut);
          if (coords.length < 2) return [];
          return [
            {
              type: "Feature" as const,
              properties: { color: p.color, walk: p.walk, mode: p.mode, line: p.label },
              geometry: { type: "LineString" as const, coordinates: coords },
            },
          ];
        }),
      });

      // 乗換駅・起終点。鉄道が絡む境界だけ丸を打つ。
      const nodes: GeoJSON.Feature[] = [];
      const pushNode = (at: [number, number], kind: string, color: string, name: string) => {
        nodes.push({
          type: "Feature",
          properties: { kind, color, name },
          geometry: { type: "Point", coordinates: at },
        });
      };
      if (parts.length > 0) {
        pushNode(parts[0].chain.pts[0], "end", "#5f6b7a", "");
        const last = parts[parts.length - 1].chain;
        pushNode(last.pts[last.pts.length - 1], "end", "#5f6b7a", "");
        for (let i = 1; i < parts.length; i++) {
          if (parts[i - 1].mode !== "transit" && parts[i].mode !== "transit") continue;
          const c = parts[i].mode === "transit" ? parts[i].color : parts[i - 1].color;
          pushNode(parts[i].chain.pts[0], "transfer", c, legs[i].from);
        }
      }

      const startPulse = () => {
        const tail = Math.max(120, total * PULSE_TAIL);
        const t0 = performance.now();
        const frame = (now: number) => {
          const phase = ((now - t0) % PULSE_MS) / PULSE_MS;
          const head = phase * (total + tail);
          const coords = slice(wholeChain, head - tail, head);
          pulseSrc.setData(
            coords.length >= 2
              ? {
                  type: "FeatureCollection",
                  features: [
                    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } },
                  ],
                }
              : EMPTY,
          );
          anim.current = requestAnimationFrame(frame);
        };
        anim.current = requestAnimationFrame(frame);
      };

      // A: 始点から終点へ線を伸ばす。600〜800ms で1回だけ。
      pulseSrc.setData(EMPTY);
      nodeSrc.setData(EMPTY);
      const t0 = performance.now();
      const draw = (now: number) => {
        const t = Math.min(1, (now - t0) / DRAW_MS);
        src.setData(featuresUpTo(easeOutCubic(t) * total));
        if (t < 1) {
          anim.current = requestAnimationFrame(draw);
          return;
        }
        nodeSrc.setData({ type: "FeatureCollection", features: nodes });
        startPulse(); // B: 描き終わったらコメットに引き継ぐ
      };
      anim.current = requestAnimationFrame(draw);
    };

    if (ready.current) apply();
    else map.once("load", apply);

    return stop;
  }, [route]);

  // --- カメラ：結果の bounds に fit（カメラ操作はツールにしない / §5 原則2） ------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const pts: [number, number][] = [];
    if (route) pts.push(...route.polyline);
    for (const it of itinerary?.days.flatMap((d) => d.items) ?? []) pts.push([it.lng, it.lat]);
    for (const p of places) pts.push([p.lng, p.lat]);
    if (pts.length === 0) return;

    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const bounds: LngLatBoundsLike = [
      [minX, minY],
      [maxX, maxY],
    ];

    // 検索結果の到着とパネル幅の確定は別のタイミングで来る。1フレーム待って
    // 最後の1回だけ動かし、連続 fit でカメラがガタつくのを防ぐ。
    const frame = requestAnimationFrame(() => {
      map.resize();
      if (pts.length === 1) {
        map.easeTo({ center: pts[0], zoom: 15.5, duration: 700 });
        return;
      }
      // ピンは座標の真上に立つので上側は厚めに。右はパネルに被されるぶんを空ける。
      // 余白がキャンバスを食い潰すと fitBounds が破綻するので上限を掛ける。
      const w = map.getCanvas().clientWidth;
      map.fitBounds(bounds, {
        padding: { top: 60, bottom: 40, left: 40, right: Math.min(padRight, Math.max(40, w * 0.55)) },
        maxZoom: 16.5,
        duration: 800,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [places, route, itinerary, padRight]);

  return (
    <>
      <div ref={holder} className="map" />
      <div className="map-attr">
        地図: <a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>
        {" © "}
        <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a>
        {" / "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
        {" / "}スポット:{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OSM</a>,{" "}
        <a href="https://www.wikidata.org/" target="_blank" rel="noreferrer">Wikidata</a>,{" "}
        <a href="https://ja.wikivoyage.org/" target="_blank" rel="noreferrer">Wikivoyage</a>
      </div>
    </>
  );
}

function popupHtml(title: string, lines: string[]): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const body = lines
    .filter((l) => l && l.trim())
    .map((l) => `<div class="popup-meta">${esc(l.length > 140 ? `${l.slice(0, 140)}…` : l)}</div>`)
    .join("");
  return `<div class="popup-title">${esc(title)}</div>${body}`;
}
