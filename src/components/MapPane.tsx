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
      map.addSource("route", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      // ルートは「地名ラベルの下」に敷く。ベクタなので、上に載せるとラベルを潰してしまう。
      const firstLabel = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
      map.addLayer(
        {
          id: "route-casing",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": 10, "line-opacity": 0.9 },
        },
        firstLabel,
      );
      map.addLayer(
        {
          id: "route-line",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": ["coalesce", ["get", "color"], MODE_COLOR.walk],
            "line-width": 5,
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

  // --- ルート ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: "FeatureCollection",
        features: route
          ? [
              {
                type: "Feature",
                properties: { color: MODE_COLOR[route.mode] ?? MODE_COLOR.walk },
                geometry: { type: "LineString", coordinates: route.polyline },
              },
            ]
          : [],
      });
    };
    if (ready.current) apply();
    else map.once("load", apply);
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
