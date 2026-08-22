"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * 地図の隅の出典表示と、その先のライセンス一覧モーダル。
 *
 * 地図タイル（OpenStreetMap）の帰属だけは**地図の上に出したまま**にしている。
 * OSM の帰属は見える形で置くのが標準の運用で、クリックの奥に隠すものではないため。
 * それ以外（東京都・区・国の機関・説明文の出どころ）は数が多く、
 * 全部を1行に並べると地図が読めなくなるのでモーダルに送っている。
 *
 * CC BY 4.0 は提供元の表示に加えて**ライセンスの明示とリンク**、
 * および**改変した旨**の表示まで求める（第3条a項）。SOURCES はその形を満たすように書いてある。
 */

type Item = { name: string; url?: string; by: string };
type Group = {
  title: string;
  license: { label: string; url: string } | null;
  note?: string;
  items: Item[];
};

const TOKYO_WARDS =
  "千代田区・文京区・台東区・江東区・品川区・大田区・渋谷区・豊島区・荒川区・板橋区・練馬区・葛飾区";

const SOURCES: Group[] = [
  {
    title: "東京都・区市町村のオープンデータ",
    license: { label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/deed.ja" },
    note: "本サービスは上記データを加工して作成しています。",
    items: [
      {
        name: "宿泊施設等の施設情報ポータルサイト「だれでも東京」",
        url: "https://catalog.data.metro.tokyo.lg.jp/dataset/t000029d0000000003",
        by: "東京都デジタルサービス局",
      },
      {
        name: "東京都内の飲食店のバリアフリー情報",
        url: "https://catalog.data.metro.tokyo.lg.jp/dataset/t000012d0000000063",
        by: "東京都産業労働局",
      },
      {
        name: "宿泊施設（旅館台帳）",
        url: "https://catalog.data.metro.tokyo.lg.jp/",
        by: TOKYO_WARDS,
      },
    ],
  },
  {
    title: "国の機関のデータ",
    license: null,
    note: "いずれも出典明示を条件に利用しています。",
    items: [
      { name: "位置参照情報", url: "https://nlftp.mlit.go.jp/isj/", by: "国土交通省" },
      {
        // 版ごとの詳細ページ（KsjTmplt-N02-v3_1.html 等）はリンク切れしやすいので配布元の入口を指す
        name: "国土数値情報 鉄道データ（N02）",
        url: "https://nlftp.mlit.go.jp/ksj/",
        by: "国土交通省",
      },
      {
        name: "標高API",
        url: "https://maps.gsi.go.jp/development/elevation_s.html",
        by: "国土地理院",
      },
      { name: "気象庁 予報データ", url: "https://www.jma.go.jp/bosai/forecast/", by: "気象庁" },
    ],
  },
  {
    title: "地図・スポット情報",
    license: null,
    items: [
      {
        name: "OpenStreetMap（ODbL 1.0）",
        url: "https://www.openstreetmap.org/copyright",
        by: "© OpenStreetMap contributors",
      },
      { name: "OpenFreeMap", url: "https://openfreemap.org", by: "ベクタタイル配信" },
      { name: "OpenMapTiles", url: "https://openmaptiles.org/", by: "タイルスキーマ" },
      {
        name: "Wikidata（CC0 1.0）",
        url: "https://creativecommons.org/publicdomain/zero/1.0/deed.ja",
        by: "スポットの説明文",
      },
      {
        name: "Wikivoyage（CC BY-SA 3.0）",
        url: "https://creativecommons.org/licenses/by-sa/3.0/deed.ja",
        by: "スポットの説明文",
      },
    ],
  },
];

/** Tab がモーダルの外へ出ないようにする（キーボードだけで操作する人向け） */
function trapFocus(panel: HTMLElement, e: KeyboardEvent) {
  const focusable = panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

export default function Attribution() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 閉じたあとに、開く前へフォーカスを戻すための控え
  const opener = useRef<HTMLElement | null>(null);

  // createPortal はサーバ側で document を触れないので、マウント後にだけ描く
  useEffect(() => setMounted(true), []);

  const close = useCallback(() => {
    setOpen(false);
    opener.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Tab" && panelRef.current) trapFocus(panelRef.current, e);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <>
      <div className="map-attr">
        {"© "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap contributors
        </a>
        {" / "}
        <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
          OpenFreeMap
        </a>
        {" / "}
        <button
          type="button"
          className="attr-open"
          onClick={(e) => {
            opener.current = e.currentTarget;
            setOpen(true);
          }}
        >
          出典・ライセンス
        </button>
      </div>

      {mounted &&
        open &&
        createPortal(
          <div className="attr-backdrop" onClick={close}>
            <div
              className="attr-panel"
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="attr-title"
              // 背景クリックで閉じるが、パネル内のクリックは伝播させない
              onClick={(e) => e.stopPropagation()}
            >
              <div className="attr-head">
                <h2 id="attr-title">出典・ライセンス</h2>
                <button type="button" className="attr-close" onClick={close} ref={closeRef}>
                  閉じる
                </button>
              </div>

              <div className="attr-body">
                {SOURCES.map((g) => (
                  <section key={g.title}>
                    <h3>
                      {g.title}
                      {g.license && (
                        <>
                          {" — "}
                          <a href={g.license.url} target="_blank" rel="noreferrer">
                            {g.license.label}
                          </a>
                        </>
                      )}
                    </h3>
                    <ul>
                      {g.items.map((it) => (
                        <li key={it.name}>
                          {it.url ? (
                            <a href={it.url} target="_blank" rel="noreferrer">
                              {it.name}
                            </a>
                          ) : (
                            it.name
                          )}
                          <span className="attr-by">{it.by}</span>
                        </li>
                      ))}
                    </ul>
                    {g.note && <p className="attr-note">{g.note}</p>}
                  </section>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
