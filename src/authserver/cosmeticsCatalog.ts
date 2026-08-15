import { Cosmetics } from "../core/CosmeticSchemas";

// Original geometric patterns, not copied from OpenFront's proprietary
// catalog (see LICENSE-ASSETS: premium skins/patterns accessed via API are
// explicitly excluded from the open-source license and are not ours to
// use). Encoded with the same open-source PatternDecoder format
// (src/core/PatternDecoder.ts) but new content: 16x16, scale 2, generated
// by a small script rather than hand-drawn or sourced from upstream.
//
// product: null on every entry -- no real-money purchase, no payment
// backend. priceSoft (tiered by rarity: common 50, uncommon 100, rare 200,
// epic 400) is paid in soft currency, which is earned for free by winning
// games (see /game/:gameId in AuthServer.ts) and spent via /shop/purchase,
// which grants the matching "pattern:<name>" flare on success. See
// src/client/Cosmetics.ts's cosmeticRelationship()/patternRelationship()
// for how flares/price/product combine into owned vs purchasable vs
// blocked.
const PATTERNS: Cosmetics["patterns"] = {
  horizontal_stripes: {
    name: "horizontal_stripes",
    product: null,
    rarity: "common",
    priceSoft: 50,
    pattern: "AHI4AAAAAP____8AAAAA_____wAAAAD_____AAAAAP____8",
  },
  vertical_stripes: {
    name: "vertical_stripes",
    product: null,
    rarity: "common",
    priceSoft: 50,
    pattern: "AHI4zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMw",
  },
  diagonal_stripes: {
    name: "diagonal_stripes",
    product: null,
    rarity: "common",
    priceSoft: 50,
    pattern: "AHI4zMxmZjMzmZnMzGZmMzOZmczMZmYzM5mZzMxmZjMzmZk",
  },
  anti_diagonal_stripes: {
    name: "anti_diagonal_stripes",
    product: null,
    rarity: "common",
    priceSoft: 50,
    pattern: "AHI4zMyZmTMzZmbMzJmZMzNmZszMmZkzM2ZmzMyZmTMzZmY",
  },
  checkerboard: {
    name: "checkerboard",
    product: null,
    rarity: "common",
    priceSoft: 50,
    pattern: "AHI4zMzMzDMzMzPMzMzMMzMzM8zMzMwzMzMzzMzMzDMzMzM",
  },
  fine_checkerboard: {
    name: "fine_checkerboard",
    product: null,
    rarity: "common",
    priceSoft: 50,
    pattern: "AHI4qqpVVaqqVVWqqlVVqqpVVaqqVVWqqlVVqqpVVaqqVVU",
  },
  dots: {
    name: "dots",
    product: null,
    rarity: "uncommon",
    priceSoft: 100,
    pattern: "AHI4AAAiIgAAAAAAACIiAAAAAAAAIiIAAAAAAAAiIgAAAAA",
  },
  small_dots: {
    name: "small_dots",
    product: null,
    rarity: "uncommon",
    priceSoft: 100,
    pattern: "AHI4SZIAAAAASZIAAAAASZIAAAAASZIAAAAASZIAAAAASZI",
  },
  crosshatch: {
    name: "crosshatch",
    product: null,
    rarity: "uncommon",
    priceSoft: 100,
    pattern: "AHI4__8RERERERH__xEREREREf__ERERERER__8RERERERE",
  },
  grid: {
    name: "grid",
    product: null,
    rarity: "uncommon",
    priceSoft: 100,
    pattern: "AHI4iIiIiIiI__-IiIiIiIj__4iIiIiIiP__iIiIiIiI__8",
  },
  diamonds: {
    name: "diamonds",
    product: null,
    rarity: "rare",
    priceSoft: 200,
    pattern: "AHI4AAAQEDg4bGzGxmxsODgQEAAAEBA4OGxsxsZsbDg4EBA",
  },
  brick: {
    name: "brick",
    product: null,
    rarity: "rare",
    priceSoft: 200,
    pattern: "AHI4__8BAQEB__8QEBAQ__8BAQEB__8QEBAQ__8BAQEB__8",
  },
  border_frame: {
    name: "border_frame",
    product: null,
    rarity: "rare",
    priceSoft: 200,
    pattern: "AHI4__8BgAGAAYABgAGAAYABgAGAAYABgAGAAYABgAGA__8",
  },
  plus_grid: {
    name: "plus_grid",
    product: null,
    rarity: "uncommon",
    priceSoft: 100,
    pattern: "AHI4IiJ3dyIiAAAiInd3IiIAACIid3ciIgAAIiJ3dyIiAAA",
  },
  triangles: {
    name: "triangles",
    product: null,
    rarity: "rare",
    priceSoft: 200,
    pattern: "AHI4AAABAQMDBwcPDx8fPz9_fwAAAQEDAwcHDw8fHz8_f38",
  },
  concentric_squares: {
    name: "concentric_squares",
    product: null,
    rarity: "epic",
    priceSoft: 400,
    pattern: "AHI4__8BgP2_BaD1rxWo1atVqlWq1asVqPWvBaD9vwGA__8",
  },
  zigzag: {
    name: "zigzag",
    product: null,
    rarity: "rare",
    priceSoft: 200,
    pattern: "AHI4g4PHx-7ufHw4OBAQAAAAAIODx8fu7nx8ODgQEAAAAAA",
  },
  ordered_dither: {
    name: "ordered_dither",
    product: null,
    rarity: "epic",
    priceSoft: 400,
    pattern: "AHI4UFUAokRVAKhVdSCqVNWAqlX3oqpV_aiqdf-qutX_quo",
  },
};

export const cosmeticsCatalog: Cosmetics = {
  patterns: PATTERNS,
  flags: {},
};
