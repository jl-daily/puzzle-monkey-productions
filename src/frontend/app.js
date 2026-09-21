let items = [];
let list = "";
let kind = "movie";
let spinList = "Rewatch w/ Di";
let resultsHidden = true;
let tabQuery = "";
const genreSel = {};
let provSel = [];
let shortOnly = false;
const SHORT_MAX = 4;
let genreOpen = false;
let provOpen = false;
let sortOpen = false;
let justUnpinned = null;
const SORTS = {
  default: "Default",
  year_desc: "Year ↓",
  year_asc: "Year ↑",
  name_asc: "Name A-Z",
  name_desc: "Name Z-A",
};
let sortSel = (() => {
  try {
    return JSON.parse(localStorage.getItem("sortSel") || "{}");
  } catch {
    return {};
  }
})();

const MOVIE_YEARS = ["2021", "2022", "2023", "2024", "2025"];
const SHOW_YEARS = [
  "Shows 2022",
  "Shows 2023",
  "Shows 2024",
  "Shows 2025",
  "Shows 2026",
];

const TABS = [
  "Rewatch w/ Di",
  "Rewatch w/o Di",
  "Movies",
  "No Di",
  "Shows",
  "Shows w/o Di",
  "2026",
  "Currently Watching",
  "Archive",
  "Taste Archive",
  "Movies Archive",
  "Shows Archive",
  ...MOVIE_YEARS,
  ...SHOW_YEARS,
  "Taste Movies",
  "Taste Shows",
];

// Primary collection tabs: an item lives on exactly one of these. The list menu
// enforces single-select among them (sheet/year tabs stay multi-select).
const PRIMARY = new Set([
  "Movies",
  "No Di",
  "2026",
  "Currently Watching",
  "Shows Archive",
  "Movies Archive",
]);

const CATS = [
  "Archive",
  "Taste Archive",
  "Movies Archive",
  "Shows Archive",
  ...MOVIE_YEARS,
  ...SHOW_YEARS,
  "Taste Movies",
  "Taste Shows",
];

const SPIN_LISTS = [
  "Rewatch w/ Di",
  "Rewatch w/o Di",
  "Movies",
  "No Di",
  "Shows",
  "Shows w/o Di",
];

const GENRE_MAP = {
  Action: "Action",
  Adventure: "Adventure",
  "Action & Adventure": "Action",
  Animation: "Animation",
  Kids: "Anime",
  Comedy: "Comedy",
  Crime: "Crime",
  Documentary: "Documentary",
  News: "Docuseries",
  Drama: "Drama",
  Family: "Drama",
  Soap: "Drama",
  "TV Movie": "Drama",
  Fantasy: "Fantasy",
  History: "History",
  Horror: "Horror",
  Music: "Music",
  Mystery: "Mystery",
  Romance: "Romance",
  "Science Fiction": "Sci-Fi",
  "Sci-Fi & Fantasy": "Sci-Fi",
  Thriller: "Thriller",
  War: "War",
  "War & Politics": "War",
  Western: "Action",
  Reality: "Reality",
  Talk: "Reality",
};

const PROVS = [
  { key: "hbo", label: "HBO" },
  { key: "tubi", label: "Tubi" },
  { key: "disney", label: "Disney+" },
  { key: "netflix", label: "Netflix" },
];

const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const resultsEl = document.getElementById("results");
const itemsEl = document.getElementById("items");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const tabSearchWrap = document.getElementById("tab-search-wrap");
const tabSearchEl = document.getElementById("tab-search");
const tabSearchClear = document.getElementById("tab-search-clear");

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "request failed");
  return data;
}

function toast(msg, isError = false) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 3500);
}

function refLine(obj, editable = false) {
  if (!obj.reference && !editable) return "";
  return `<p class="ref${obj.reference ? "" : " none"}">↳ ${
    obj.reference ? `"${obj.reference}"` : "add comment"
  }</p>`;
}

function fmtDate(s) {
  const d = new Date(String(s).replace(/-/g, "/"));
  if (isNaN(d)) return s;
  const opts =
    d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

function fmtRuntime(m) {
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (!h) return `${rem}m`;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function rewatchYear(e) {
  const y =
    (e.watched_at || "").slice(0, 4) ||
    ((e.tab || "").match(/20\d\d/) || [])[0] ||
    "";
  return y ? y.slice(2) : "??";
}

function scoreColor(v) {
  return `hsl(${Math.round((Math.min(100, Math.max(1, v)) / 100) * 120)}, 85%, 45%)`;
}

function scoreChip(label, v) {
  if (v == null) return "";
  const c = scoreColor(v);
  return `<span class="score-chip" style="color:${c};border-color:${c}">${label} ${v}</span>`;
}

function epState(it, s) {
  const prog = it.episode_progress || {};
  const counts = it.season_counts || {};
  if (s == null) {
    s = Math.max(0, ...Object.keys(prog).map(Number));
    if (!s) {
      const known = Object.keys(counts).map(Number);
      s = known.length ? Math.min(...known) : 1;
    }
  }
  const arr = (prog[s] || []).slice().sort((a, b) => a - b);
  const count = counts[s];
  const last = arr.length ? arr[arr.length - 1] : 0;
  const done = it.status === "done" || (count != null && last >= count);
  return { s, count, last, done };
}

// Known seasons for a show: every season with an episode count (season_counts)
// plus any season that has its own entry (scores/review/rewatch).
function seasonsOf(it) {
  const counts = it.season_counts || {};
  const keys = Object.keys(counts);
  if (
    keys.length === 1 &&
    it.current_season != null &&
    String(it.current_season) === keys[0]
  ) {
    return [it.current_season];
  }
  const set = new Set();
  for (const sn of keys) {
    const n = Number(sn);
    if (Number.isFinite(n) && n > 0) set.add(n);
  }
  for (const e of it.season_entries || []) {
    if (Number.isFinite(e.season) && e.season > 0) set.add(e.season);
  }
  return [...set].sort((a, b) => a - b);
}

// A season's pin level lives on its season_entries entry (0 = none, 1 = alone,
// 2 = with Diana), mirroring the whole-show pinned model.
function seasonPin(it, s) {
  const e = (it.season_entries || []).find((x) => x.season === s);
  return (e && e.pinned) || 0;
}

// A show's effective pin level is the whole-show pin OR the highest season pin
// (a double-pinned season should surface the whole show in the Diana box).
function effectivePin(it) {
  let p = it.pinned || 0;
  for (const e of it.season_entries || []) p = Math.max(p, e.pinned || 0);
  return p;
}

// The season currently being watched: the one with a start date but no finish
// date; else the season with partial episode progress; else the next known
// season that isn't complete yet (a finished date or a sheet-sourced watched_at
// counts as complete). Returns null when every known season is done, so no
// season shows tracking.
function currentSeason(it) {
  if (it.status === "done") return null;
  const sd = it.season_dates || {};
  const prog = it.episode_progress || {};
  const counts = it.season_counts || {};
  const entries = it.season_entries || [];
  const seasons = seasonsOf(it);
  const cur = it.current_season;
  if (cur != null && seasons.includes(cur)) return cur;
  if (it.my_rating != null || it.di_rating != null) return null;
  const complete = (s) => {
    const arr = prog[s] || [];
    const c = counts[s];
    if (arr.length && c != null) return arr.length >= c;
    const d = sd[s];
    if (d && d.finished_at) return true;
    const entry = entries.find((e) => e.season === s);
    if (entry) {
      if (entry.watched_at) return true;
      if (entry.my_rating != null || entry.di_rating != null) return true;
    }
    return false;
  };
  for (const s of seasons) {
    const d = sd[s];
    if (d && d.started_at && !d.finished_at) return s;
  }
  for (const s of seasons) {
    const arr = prog[s] || [];
    const c = counts[s];
    if (arr.length && (c == null || arr.length < c)) return s;
  }
  for (const s of seasons) {
    if (!complete(s)) return s;
  }
  return null;
}

// A season counts as active (worth showing on the Currently Watching journal) once
// the user has touched it: a start/finish date, any episode progress, a season
// entry (rating/review/reference/rewatch), or it's the current season.
// A season counts as complete once it has a finish date, a watched_at on its
// entry, or full episode progress recorded.
function seasonComplete(it, s) {
  const sd = (it.season_dates || {})[s];
  if (sd && sd.finished_at) return true;
  const entry = (it.season_entries || []).find((e) => e.season === s);
  if (entry && entry.watched_at) return true;
  const prog = (it.episode_progress || {})[s] || [];
  const count = (it.season_counts || {})[s];
  return !!(prog.length && count != null && prog.length >= count);
}

// A season is "scored" if it carries its own rating or the show has any score.
function seasonScored(it, s) {
  const entry = (it.season_entries || []).find((e) => e.season === s);
  if (entry && (entry.my_rating != null || entry.di_rating != null))
    return true;
  return it.taste_score != null || it.my_rating != null || it.di_rating != null;
}

// A finished, scored season that isn't the one being watched gets filed under
// Shows Archive; everything else stays on the watchlist / Currently Watching.
function seasonArchived(it, s) {
  if (s === it.current_season) return false;
  return seasonComplete(it, s) && seasonScored(it, s);
}

// A season you've actually started (or are on): it has a start date, any
// episode progress, a season entry, or is the current season. Future, untouched
// seasons don't count, so Currently Watching stays focused on what you're watching.
function seasonStarted(it, s) {
  const sd = (it.season_dates || {})[s];
  if (sd && sd.started_at) return true;
  if (((it.episode_progress || {})[s] || []).length) return true;
  if ((it.season_entries || []).some((e) => e.season === s)) return true;
  return it.current_season === s;
}

function epTrack(it, s, bare) {
  const eps = epState(it, s);
  if (eps.done || seasonComplete(it, s)) return "";
  const pre = bare ? "" : `S${eps.s} · `;
  const label = eps.done
    ? bare
      ? "done"
      : `S${eps.s} done`
    : `${pre}E${eps.last + 1}${eps.count != null ? "/" + eps.count : ""}`;
  return `<span class="ep-track">
    <button class="ep-btn ep-minus" data-season="${eps.s}" title="Undo last episode">−</button>
    <span class="ep-label">${label}</span>
    <button class="ep-btn ep-plus" data-season="${eps.s}" title="Mark episode watched">+</button>
  </span>`;
}

function epLabel(it, s) {
  const eps = epState(it, s);
  if (eps.done) return `S${eps.s} done`;
  return `S${eps.s} · E${eps.last + 1}${eps.count != null ? "/" + eps.count : ""}`;
}

function attachEpBtns(root, it) {
  for (const btn of root.querySelectorAll(".ep-btn")) {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const body = {
          op: btn.classList.contains("ep-plus") ? "inc" : "dec",
        };
        const sn = Number(btn.dataset.season);
        if (Number.isFinite(sn) && sn > 0) body.season = sn;
        const u = await api(`/api/items/${it.id}/episodes`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        Object.assign(it, u);
        render();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }
}

function pinBtnHtml(it, s) {
  if (it.kind !== "tv") return "";
  const lvl = s != null ? seasonPin(it, s) : it.pinned || 0;
  const scope = s != null ? `Season ${s} ` : "";
  const icon = "📌";
  const title = lvl
    ? `${scope}with Diana. Click to unpin.`
    : `${scope}pin to watch with Diana. Click to pin.`;
  return `<button class="pin-btn${lvl ? " on" : ""}" title="${title}">${icon}</button>`;
}

function attachPin(el, it, s) {
  const pinBtn = el.querySelector(".pin-btn");
  if (!pinBtn) return;
  pinBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (s != null) {
      const entries = [...(it.season_entries || [])];
      const idx = entries.findIndex((en) => en.season === s);
      const prev = idx >= 0 ? entries[idx] : {};
      const lvl = prev.pinned || 0;
      const upd = { ...prev, season: s, pinned: lvl === 1 ? 0 : 1 };
      if (idx >= 0) entries[idx] = upd;
      else entries.push(upd);
      api(`/api/items/${it.id}`, {
        method: "PATCH",
        body: JSON.stringify({ season_entries: entries }),
      })
        .then((updated) => {
          Object.assign(it, updated);
          render();
        })
        .catch((err) => toast(err.message, true));
      return;
    }
    const lvl = it.pinned || 0;
    const next = lvl === 1 ? 0 : 1;
    api(`/api/items/${it.id}`, {
      method: "PATCH",
      body: JSON.stringify({ pinned: next }),
    })
      .then(() => {
        if (next === 0) justUnpinned = it.id;
        load();
      })
      .catch((err) => toast(err.message, true));
  });
}

const CONFIRM_LISTS = ["Rewatch w/ Di", "Movies", "Shows"];

function confirmBtnHtml(it, list) {
  if (!CONFIRM_LISTS.includes(list)) return "";
  const on = !!it.di_confirmed;
  const title = on
    ? "Diana confirmed — stays on the sheet. Click to unmark."
    : "Mark as confirmed by Diana (stays on the sheet).";
  return `<button class="confirm-btn${on ? " on" : ""}" title="${title}">🧩</button>`;
}

function attachConfirm(el, it) {
  const btn = el.querySelector(".confirm-btn");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    api(`/api/items/${it.id}`, {
      method: "PATCH",
      body: JSON.stringify({ di_confirmed: !it.di_confirmed }),
    })
      .then((updated) => {
        Object.assign(it, updated);
        render();
      })
      .catch((err) => toast(err.message, true));
  });
}

function seasonCard(it, s, cur, list, showLists = false, chips = true) {
  const entry = (it.season_entries || []).find((e) => e.season === s);
  const rw = entry && entry.rewatch;
  const el = document.createElement("div");
  el.dataset.id = it.id;
  el.className =
    "card season-full" +
    (it.status === "done" ? " watched" : "") +
    (it.status === "watching" ? " watching" : "") +
    (it.theater ? " theater" : "") +
    (rw ? " rewatch" : "");
  const poster = it.poster
    ? `<img class="poster" src="${it.poster}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
    : `<div class="poster placeholder">${(it.title[0] || "").toUpperCase()}</div>`;
  const scores = entry
    ? [
        scoreChip("You", entry.my_rating),
        scoreChip("Di", entry.di_rating),
      ].join("")
    : "";
  const tasteColor =
    it.taste_score != null
      ? `hsl(${Math.round(
          (Math.min(100, Math.max(0, it.taste_score)) / 100) * 120,
        )}, 85%, 42%)`
      : "";
  const sd = (it.season_dates || {})[s] || {};
  const started = sd.started_at
    ? `<button class="epdates edit" data-what="started" title="Change season started date">Started ${fmtDate(sd.started_at)}</button>`
    : "";
  const finished =
    sd.finished_at || (entry && entry.watched_at)
      ? `<button class="epdates edit" data-what="finished" title="Change season finished date">Finished ${fmtDate(sd.finished_at || (entry && entry.watched_at))}</button>`
      : "";
  let daysHtml = "";
  if (sd.started_at && sd.finished_at) {
    const d = Math.round(
      (new Date(sd.finished_at).getTime() - new Date(sd.started_at).getTime()) /
        86400000,
    );
    if (d >= 0)
      daysHtml = `<span class="epdates" title="Days from start to finish">· ${d} days</span>`;
  }
  const seasons = seasonsOf(it);
  const chipsHtml =
    chips && seasons.length > 1
      ? `<span class="season-chips">${seasons
          .map(
            (n) =>
              `<button class="season-chip${n === s ? " on" : ""}" data-season="${n}" title="Confirm Season ${n} as current">S${n}</button>`,
          )
          .join("")}</span>`
      : "";
  const nextS = (() => {
    const i = seasons.indexOf(s);
    if (i < 0 || i + 1 >= seasons.length) return null;
    if (!seasonComplete(it, s)) return null;
    return seasons[i + 1];
  })();
  const nextBtn =
    nextS != null
      ? `<button class="next-season-btn" data-next="${nextS}" title="Jump to Season ${nextS}">→ S${nextS}</button>`
      : "";
  const prov = [
    ...new Set(
      (it.providers || [])
        .map((p) => {
          const n = p.name.toLowerCase();
          if (n.includes("hbo")) return "HBO";
          if (n.includes("tubi")) return "Tubi";
          if (n.includes("disney")) return "Disney+";
          if (n.includes("netflix")) return "Netflix";
          return "";
        })
        .filter(Boolean),
    ),
  ]
    .map((label) => {
      const c =
        label === "HBO"
          ? "#002BE7"
          : label === "Disney+"
            ? "#2A9DF4"
            : label === "Netflix"
              ? "#E50914"
              : "#FF00B5";
      const href =
        label === "HBO"
          ? "https://play.max.com/search?q=" + encodeURIComponent(it.title)
          : label === "Disney+"
            ? "https://www.disneyplus.com/search?q=" +
              encodeURIComponent(it.title)
            : label === "Netflix"
              ? "https://www.netflix.com/search?q=" +
                encodeURIComponent(it.title)
              : "https://tubitv.com/search/" + encodeURIComponent(it.title);
      return `<a class="prov" style="background:${c}" href="${href}" target="_blank" rel="noopener">${label}</a>`;
    })
    .join("");
  el.innerHTML = `
    ${poster}
    <div class="info">
      <div class="title-row">
        <h3><a href="#" class="taste-link" data-title="${esc(it.title)}" data-kind="${it.kind}" data-year="${esc(it.year || "")}" data-href="${tasteHref(it)}">${esc(it.title)}</a></h3>
        ${it.year ? `<span class="year">${it.year}</span>` : ""}
        ${pinBtnHtml(it)}
        ${confirmBtnHtml(it, list)}
        <span class="season-tag${rw ? " rewatch" : ""}">Season ${s}${rw ? ` · Rewatch '${rewatchYear(entry)}` : ""}</span>
        ${prov ? `<span class="providers">${prov}</span>` : ""}
      </div>
      <div class="meta">
        ${tasteColor ? `<span class="taste" style="background:${tasteColor}">Taste ${it.taste_score}</span>` : ""}
        ${scores ? `<span class="season-scores">${scores}</span>` : ""}
        ${s === cur || s === it.current_season || list === "Currently Watching" ? epTrack(it, s, true) : ""}
        ${started}
        ${finished}
        ${daysHtml}
        ${
          showLists && it.lists && it.lists.length
            ? `<span class="lists-tag">${it.lists.join(" · ")}</span>`
            : ""
        }
      </div>
      ${it.overview ? `<p class="overview">${it.overview}</p>` : ""}
      <p class="review${entry && entry.review ? "" : " add"}">${
        entry && entry.review ? `"${entry.review}"` : "Add comment"
      }</p>
      <p class="review di${entry && entry.di_review ? "" : " add"}">${entry && entry.di_review ? `"${entry.di_review}"` : "Add Diana's comment"}</p>
      ${refLine(entry || {}, true)}
      <div class="actions">
        <button class="score-btn" title="Enter scores (1–100)">Score</button>
        <button class="lists-btn">Lists</button>
        <div class="list-menu hidden"></div>
      </div>
    </div>
    ${
      it.kind === "tv"
        ? `<span class="rw-emblem${rw ? " on" : ""}" title="${
            rw ? "Rewatched — click to clear" : "Mark as rewatched"
          }">🔁</span>`
        : ""
    }
  `;
  const listsBtn = el.querySelector(".lists-btn");
  const menu = el.querySelector(".list-menu");
  listsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const hidden = menu.classList.toggle("hidden");
    if (!hidden) {
      menu.innerHTML = "";
      buildListMenu(menu, it);
      el.style.zIndex = "50";
      el.style.opacity = "1";
    } else {
      el.style.zIndex = "";
      el.style.opacity = "";
    }
  });
  const scoreBtn = el.querySelector(".score-btn");
  if (scoreBtn)
    scoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openScoreInline(scoreBtn, it, s);
    });
  const rwEmblem = el.querySelector(".rw-emblem");
  if (rwEmblem)
    rwEmblem.addEventListener("click", (e) => {
      e.stopPropagation();
      const entries = [...(it.season_entries || [])];
      const idx = entries.findIndex((en) => en.season === s);
      const prev = idx >= 0 ? entries[idx] : {};
      const upd = {
        ...prev,
        season: s,
        tab: prev.tab || list,
        rewatch: !prev.rewatch,
      };
      if (idx >= 0) entries[idx] = upd;
      else entries.push(upd);
      api(`/api/items/${it.id}`, {
        method: "PATCH",
        body: JSON.stringify({ season_entries: entries }),
      })
        .then((updated) => {
          Object.assign(it, updated);
          render();
        })
        .catch((err) => toast(err.message, true));
    });
  const refEl = el.querySelector(".ref");
  if (refEl)
    refEl.addEventListener("click", () => startEdit(refEl, "reference", it, s));
  const reviewEl = el.querySelector(".review:not(.di)");
  if (reviewEl)
    reviewEl.addEventListener("click", () =>
      startEdit(reviewEl, "review", it, s),
    );
  const diEl = el.querySelector(".review.di");
  if (diEl)
    diEl.addEventListener("click", () => startEdit(diEl, "di_review", it, s));
  for (const chip of el.querySelectorAll(".season-chip[data-season]")) {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const n = Number(chip.dataset.season);
      api(`/api/items/${it.id}`, {
        method: "PATCH",
        body: JSON.stringify({ current_season: n === s ? null : n }),
      })
        .then((updated) => {
          Object.assign(it, updated);
          render();
        })
        .catch((err) => toast(err.message, true));
    });
  }
  const nextBtnEl = el.querySelector(".next-season-btn");
  if (nextBtnEl)
    nextBtnEl.addEventListener("click", (e) => {
      e.stopPropagation();
      api(`/api/items/${it.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          current_season: Number(nextBtnEl.dataset.next),
        }),
      })
        .then((updated) => {
          Object.assign(it, updated);
          render();
        })
        .catch((err) => toast(err.message, true));
    });
  for (const btn of el.querySelectorAll(".epdates.edit")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editSeasonDate(btn, it, s, btn.dataset.what);
    });
  }
  attachEpBtns(el, it);
  attachPin(el, it);
  attachConfirm(el, it);
  return el;
}

function seasonTracker(it, active, list) {
  const wrap = document.createElement("div");
  wrap.className = "season-list";
  const ss = seasonsOf(it);
  if (!ss.length) return wrap;
  const head = document.createElement("div");
  head.className = "season-list-head";
  head.textContent = `Seasons (${ss.length})`;
  wrap.appendChild(head);
  for (const s of ss) {
    const entry = (it.season_entries || []).find((e) => e.season === s);
    const scores = [
      scoreChip("You", entry && entry.my_rating),
      scoreChip("Di", entry && entry.di_rating),
    ].join("");
    const row = document.createElement("div");
    row.className =
      "season-row" +
      (s === active ? " active" : "") +
      (entry && entry.rewatch ? " rewatch" : "");
    row.dataset.season = s;
    row.innerHTML = `
      <button class="season-row-tag" data-season="${s}" title="Show Season ${s}">S${s}</button>
      <div class="season-row-body">
        <span class="season-row-ep">${epLabel(it, s)}</span>
        ${scores ? `<span class="season-row-scores">${scores}</span>` : `<span class="season-row-scores none">no score</span>`}
      </div>`;
    const tag = row.querySelector(".season-row-tag");
    tag.addEventListener("click", (e) => {
      e.stopPropagation();
      api(`/api/items/${it.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          current_season: s === it.current_season ? null : s,
        }),
      })
        .then((updated) => {
          Object.assign(it, updated);
          render();
        })
        .catch((err) => toast(err.message, true));
    });
    const scoresEl = row.querySelector(".season-row-scores");
    if (scoresEl)
      scoresEl.addEventListener("click", (e) => {
        e.stopPropagation();
        openScoreInline(scoresEl, it, s);
      });
    wrap.appendChild(row);
  }
  return wrap;
}

function seasonChipsHtml(it, active) {
  const ss = seasonsOf(it);
  if (ss.length <= 1) return "";
  return `<span class="season-chips">${ss
    .map(
      (n) =>
        `<button class="season-chip${n === active ? " on" : ""}" data-season="${n}" title="Set Season ${n} as current">S${n}</button>`,
    )
    .join("")}</span>`;
}

function attachSeasonChips(el, it) {
  for (const chip of el.querySelectorAll(".season-chip[data-season]")) {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      const n = Number(chip.dataset.season);
      api(`/api/items/${it.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          current_season: n === it.current_season ? null : n,
        }),
      })
        .then((updated) => {
          Object.assign(it, updated);
          render();
        })
        .catch((err) => toast(err.message, true));
    });
  }
}

function epDates(it) {
  const pills = [];
  if (it.ep_started_at)
    pills.push(
      `<span class="epdates" title="Day started">Started ${fmtDate(it.ep_started_at)}</span>`,
    );
  if (it.watched_at || it.ep_finished_at)
    pills.push(
      `<span class="epdates" title="Day finished">Finished ${fmtDate(it.watched_at || it.ep_finished_at)}</span>`,
    );
  return pills.join("");
}

function card(it, list, showLists = false) {
  const multi = it.kind === "tv" && seasonsOf(it).length > 0;
  const ss = multi ? seasonsOf(it) : [];
  const cur = multi ? currentSeason(it) : null;
  const active = multi
    ? ((ss.includes(it.current_season) ? it.current_season : null) ??
      cur ??
      ss[0])
    : null;
  const el = document.createElement("div");
  el.dataset.id = it.id;
  el.className =
    "card" +
    (it.status === "done" ? " watched" : "") +
    (it.status === "watching" ? " watching" : "") +
    (it.theater ? " theater" : "") +
    (it.rewatch ? " rewatch" : "");
  const poster = it.poster
    ? `<img class="poster" src="${it.poster}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
    : `<div class="poster placeholder">${(it.title[0] || "").toUpperCase()}</div>`;

  const entries = (it.season_entries || []).filter(
    (e) =>
      e.rewatch ||
      e.review ||
      e.reference ||
      e.my_rating != null ||
      e.di_rating != null,
  );
  const scores = entries.length
    ? ""
    : [
        scoreChip(
          "You",
          it.my_rating != null && it.kind !== "tv" ? it.my_rating : null,
        ),
        scoreChip("Di", it.di_rating),
      ].join("");

  const seasonBlock = multi
    ? ""
    : entries.length
      ? `<div class="seasons">${entries
          .map((e) => {
            const s = [
              scoreChip("You", e.my_rating),
              scoreChip("Di", e.di_rating),
            ].join("");
            const rw = !!e.rewatch;
            const tag = rw
              ? `Rewatch '${rewatchYear(e)}`
              : entries.length > 1
                ? `S${e.season}`
                : "";
            return `<div class="season${rw ? " rewatch" : ""}">
            ${
              tag
                ? `<span class="season-tag${rw ? " rewatch" : ""}">${tag}</span>`
                : ""
            }
            ${s ? `<span class="season-scores">${s}</span>` : ""}
            ${e.review ? `<p class="review">"${e.review}"</p>` : ""}
          </div>`;
          })
          .join("")}</div>`
      : "";

  const singleSeason =
    it.kind === "tv" &&
    it.seasons === 1 &&
    it.current_season != null &&
    it.season_counts &&
    Object.keys(it.season_counts).length === 1;
  const showmeta =
    it.kind === "tv" && it.seasons != null
      ? singleSeason
        ? `Season ${it.current_season} · ${it.episodes == null ? "?" : it.episodes} episode${it.episodes === 1 ? "" : "s"}`
        : `${it.seasons} season${it.seasons === 1 ? "" : "s"} · ${it.episodes == null ? "?" : it.episodes} episode${it.episodes === 1 ? "" : "s"}`
      : "";

  const epTrackHtml = multi
    ? ""
    : it.kind === "tv" &&
        (it.status !== "done" || list === "Currently Watching")
      ? epTrack(it)
      : "";
  const epDatesChip = it.kind === "tv" ? epDates(it) : "";

  const tasteColor =
    it.taste_score != null
      ? `hsl(${Math.round(
          (Math.min(100, Math.max(0, it.taste_score)) / 100) * 120,
        )}, 85%, 42%)`
      : "";

  const watched =
    it.watched_at || list === "2026"
      ? `<button class="watched edit" title="${
          it.watched_at ? "Change watched date" : "Add watched date"
        }">${
          it.watched_at
            ? "Watched " + fmtDate(it.watched_at)
            : "Add watched date"
        }</button>`
      : "";

  const added = it.list_dates && it.list_dates[list];
  const addedChip = added
    ? `<button class="added edit" data-list="${list}" title="Change date added to ${list}">Added ${fmtDate(added)}</button>`
    : "";

  const prov = [
    ...new Set(
      (it.providers || [])
        .map((p) => {
          const n = p.name.toLowerCase();
          if (n.includes("hbo")) return "HBO";
          if (n.includes("tubi")) return "Tubi";
          if (n.includes("disney")) return "Disney+";
          if (n.includes("netflix")) return "Netflix";
          return "";
        })
        .filter(Boolean),
    ),
  ]
    .map((label) => {
      const c =
        label === "HBO"
          ? "#002BE7"
          : label === "Disney+"
            ? "#2A9DF4"
            : label === "Netflix"
              ? "#E50914"
              : "#FF00B5";
      const href =
        label === "HBO"
          ? "https://play.max.com/search?q=" + encodeURIComponent(it.title)
          : label === "Disney+"
            ? "https://www.disneyplus.com/search?q=" +
              encodeURIComponent(it.title)
            : label === "Netflix"
              ? "https://www.netflix.com/search?q=" +
                encodeURIComponent(it.title)
              : "https://tubitv.com/search/" + encodeURIComponent(it.title);
      return `<a class="prov" style="background:${c}" href="${href}" target="_blank" rel="noopener">${label}</a>`;
    })
    .join("");

  const runtimeTxt = it.runtime
    ? it.kind === "tv"
      ? `~${fmtRuntime(it.runtime)} eps`
      : fmtRuntime(it.runtime)
    : "";
  const directorTxt = it.director
    ? `${it.kind === "tv" ? "Created by" : "Director"}: ${it.director}`
    : "";

  el.innerHTML = `
    ${poster}
    <div class="info">
      <div class="title-row">
        <h3><a href="#" class="taste-link" data-title="${esc(it.title)}" data-kind="${it.kind}" data-year="${esc(it.year || "")}" data-href="${tasteHref(it)}">${esc(it.title)}</a></h3>
        ${it.year ? `<span class="year">${it.year}</span>` : ""}
        ${pinBtnHtml(it)}
        ${confirmBtnHtml(it, list)}
        <span class="badge">${it.kind === "tv" ? "SHOW" : "MOVIE"}</span>
        ${prov ? `<span class="providers">${prov}</span>` : ""}
      </div>
      <div class="meta">
        ${tasteColor ? `<span class="taste" style="background:${tasteColor}">Taste ${it.taste_score}</span>` : ""}
        ${scores}
        ${showmeta ? `<span class="episodes">${showmeta}</span>` : ""}
        ${runtimeTxt ? `<span class="runtime">${runtimeTxt}</span>` : ""}
        ${directorTxt ? `<span class="director">${directorTxt}</span>` : ""}
        ${epTrackHtml}
        ${epDatesChip}
        ${watched ? `<span class="watched">${watched}</span>` : ""}
        ${
          showLists && it.lists && it.lists.length
            ? `<span class="lists-tag">${it.lists.join(" · ")}</span>`
            : ""
        }
        ${it.genres ? `<span class="genres">${it.genres}</span>` : ""}
      </div>
      ${it.overview ? `<p class="overview">${it.overview}</p>` : ""}
      ${
        multi
          ? ""
          : entries.length
            ? seasonBlock
            : `<p class="review${it.review ? "" : " add"}">${
                it.review ? `"${it.review}"` : "Add comment"
              }</p>`
      }
      <p class="review di${it.di_review ? "" : " add"}">${it.di_review ? `"${it.di_review}"` : "Add Diana's comment"}</p>
      ${refLine(it, true)}
      <div class="actions">
        ${
          list === "Movies"
            ? `<button class="nodi-btn" title="She doesn't want to watch this">No Di</button>`
            : list === "No Di"
              ? `<button class="undo-btn" title="Move back to Movies">↩ Movies</button>`
              : list === "Shows"
                ? `<button class="nodi-btn" data-move="shows-nodi" title="She doesn't want to watch this">No Di</button>`
                : list === "Shows w/o Di"
                  ? `<button class="undo-btn" data-move="shows-back" title="Move back to Shows">↩ Shows</button>`
                  : list === "Rewatch w/ Di"
                    ? `<button class="nodi-btn" data-move="rewatch-nodi" title="She doesn't want to rewatch this">w/o Di</button>`
                    : list === "Rewatch w/o Di"
                      ? `<button class="undo-btn" data-move="rewatch-back" title="Move back to Rewatch w/ Di">↩ w/ Di</button>`
                      : ""
        }
        <button class="score-btn" title="Enter scores (1–100)">Score</button>
        <button class="lists-btn">Lists</button>
        <div class="list-menu hidden"></div>
      </div>
    </div>
    ${
      it.kind === "movie"
        ? `<span class="theater-emblem${it.theater ? " on" : ""}" title="${
            it.theater
              ? "Saw in theaters — click to clear"
              : "Mark as seen in theaters"
          }">🎬</span>`
        : ""
    }
    ${
      it.kind === "movie"
        ? `<span class="rw-emblem${it.rewatch ? " on" : ""}" title="${
            it.rewatch
              ? `Rewatched ${it.rewatched_at ? fmtDate(it.rewatched_at) : ""} — click to clear`
              : "Mark as rewatched"
          }">🔁</span>`
        : ""
    }
  </div>
  `;

  const listsBtn = el.querySelector(".lists-btn");
  const menu = el.querySelector(".list-menu");
  listsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const hidden = menu.classList.toggle("hidden");
    if (!hidden) {
      menu.innerHTML = "";
      buildListMenu(menu, it);
      el.style.zIndex = "50";
      el.style.opacity = "1";
    } else {
      el.style.zIndex = "";
      el.style.opacity = "";
    }
  });

  const nodiBtn = el.querySelector(".nodi-btn");
  if (nodiBtn)
    nodiBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const m = nodiBtn.dataset.move;
      if (m === "shows-nodi") return moveItem(it, "Shows", "Shows w/o Di");
      if (m === "rewatch-nodi")
        return moveItem(it, "Rewatch w/ Di", "Rewatch w/o Di");
      moveItem(it, "Movies", "No Di");
    });
  const undoBtn = el.querySelector(".undo-btn");
  if (undoBtn)
    undoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const m = undoBtn.dataset.move;
      if (m === "shows-back") return moveItem(it, "Shows w/o Di", "Shows");
      if (m === "rewatch-back")
        return moveItem(it, "Rewatch w/o Di", "Rewatch w/ Di");
      moveItem(it, "No Di", "Movies");
    });

  const scoreBtn = el.querySelector(".score-btn");
  if (scoreBtn)
    scoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openScoreInline(scoreBtn, it);
    });

  const rwEmblem = el.querySelector(".rw-emblem");
  if (rwEmblem)
    rwEmblem.addEventListener("click", (e) => {
      e.stopPropagation();
      api(`/api/items/${it.id}`, {
        method: "PATCH",
        body: JSON.stringify({ rewatch: !it.rewatch, tab: list }),
      })
        .then((updated) => {
          Object.assign(it, updated);
          render();
        })
        .catch((err) => toast(err.message, true));
    });

  const theaterBtn = el.querySelector(".theater-emblem");
  if (theaterBtn)
    theaterBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      api(`/api/items/${it.id}`, {
        method: "PATCH",
        body: JSON.stringify({ theater: !it.theater }),
      })
        .then((updated) => {
          Object.assign(it, updated);
          render();
        })
        .catch((err) => toast(err.message, true));
    });

  const refEl = el.querySelector(".ref");
  if (refEl)
    refEl.addEventListener("click", () => startEdit(refEl, "reference", it));
  const reviewEl = el.querySelector(".review:not(.di)");
  if (reviewEl)
    reviewEl.addEventListener("click", () => startEdit(reviewEl, "review", it));
  const diEl = el.querySelector(".review.di");
  if (diEl)
    diEl.addEventListener("click", () => startEdit(diEl, "di_review", it));
  const watchedEl = el.querySelector(".watched.edit");
  if (watchedEl)
    watchedEl.addEventListener("click", (e) => {
      e.stopPropagation();
      editWatched(watchedEl, it);
    });

  const addedEl = el.querySelector(".added.edit");
  if (addedEl)
    addedEl.addEventListener("click", (e) => {
      e.stopPropagation();
      editListDate(addedEl, it, addedEl.dataset.list);
    });

  attachEpBtns(el, it);

  attachPin(el, it);
  attachConfirm(el, it);

  if (multi) {
    const cur = currentSeason(it);
    const ss = seasonsOf(it);
    const frag = document.createDocumentFragment();
    if (list === "Currently Watching" || list === "Shows Archive") {
      const pinned = (it.pinned || 0) >= 1;
      let disp = cur;
      if (disp == null && pinned)
        disp = it.current_season ?? ss[ss.length - 1] ?? ss[0] ?? null;
      let js;
      if (list === "Shows Archive") {
        js = ss.filter((s) => seasonArchived(it, s));
        if (pinned && disp != null && !js.includes(disp)) js.push(disp);
      } else {
        if (disp != null) {
          js = [disp];
        } else {
          js = ss.filter((s) => seasonStarted(it, s));
        }
      }
      if (!js.length)
        js =
          it.current_season != null && ss.includes(it.current_season)
            ? [it.current_season]
            : [ss[ss.length - 1]];
      if (js.length) {
        for (const s of js)
          frag.appendChild(seasonCard(it, s, disp, list, showLists, false));
        return frag;
      }
      attachSeasonChips(el, it);
      return el;
    }
    attachSeasonChips(el, it);
    return el;
  }
  return el;
}

function editableSave(input, field, it, season = null) {
  const v = (input.value || "").trim();
  const body = {};
  if (season != null) {
    const entries = [...(it.season_entries || [])];
    const idx = entries.findIndex((e) => e.season === season);
    const upd = {
      ...(idx >= 0 ? entries[idx] : {}),
      season,
      [field]: v || null,
    };
    if (idx >= 0) entries[idx] = upd;
    else entries.push(upd);
    body.season_entries = entries;
  } else {
    body[field] = v || null;
  }
  api(`/api/items/${it.id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
    .then((updated) => {
      Object.assign(it, updated);
      render();
    })
    .catch((err) => {
      toast(err.message, true);
      render();
    });
}

function startEdit(el, field, it, season = null) {
  const area = field === "review";
  const input = document.createElement(area ? "textarea" : "input");
  input.className = "inline-edit" + (area ? " area" : "");
  const entry =
    season != null
      ? (it.season_entries || []).find((e) => e.season === season)
      : null;
  input.value =
    season != null ? (entry && entry[field]) || "" : it[field] || "";
  el.replaceWith(input);
  input.focus();
  if (input.select) input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) editableSave(input, field, it, season);
    else render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return finish(false);
    if (e.key === "Enter" && (!area || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      finish(true);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function editWatched(el, it) {
  const input = document.createElement("input");
  input.type = "date";
  input.className = "inline-edit date";
  input.value = (it.watched_at || "").slice(0, 10);
  el.replaceWith(input);
  input.focus();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (!save || !input.value) return render();
    api(`/api/items/${it.id}`, {
      method: "PATCH",
      body: JSON.stringify({ watched_at: input.value }),
    })
      .then((updated) => {
        Object.assign(it, updated);
        render();
      })
      .catch((err) => {
        toast(err.message, true);
        render();
      });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return finish(false);
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function editListDate(el, it, listName) {
  const input = document.createElement("input");
  input.type = "date";
  input.className = "inline-edit date";
  const cur = (it.list_dates && it.list_dates[listName]) || "";
  input.value = cur.slice(0, 10);
  el.replaceWith(input);
  input.focus();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (!save || !input.value) return render();
    api(`/api/items/${it.id}/list-date`, {
      method: "PUT",
      body: JSON.stringify({ list: listName, added_at: input.value }),
    })
      .then((updated) => {
        Object.assign(it, updated);
        render();
      })
      .catch((err) => {
        toast(err.message, true);
        render();
      });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return finish(false);
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function editSeasonDate(el, it, s, which) {
  const input = document.createElement("input");
  input.type = "date";
  input.className = "inline-edit date";
  const sd = (it.season_dates || {})[s] || {};
  const entry = (it.season_entries || []).find((e) => e.season === s);
  const cur =
    which === "started"
      ? sd.started_at
      : sd.finished_at || (entry && entry.watched_at);
  input.value = (cur || "").slice(0, 10);
  el.replaceWith(input);
  input.focus();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (!save || !input.value) return render();
    const v = input.value;
    const sdates = { ...(it.season_dates || {}) };
    const prev = { ...(sdates[s] || {}) };
    const body = {};
    if (which === "started") {
      sdates[s] = { ...prev, started_at: v };
    } else {
      sdates[s] = { ...prev, finished_at: v };
      const entries = [...(it.season_entries || [])];
      const idx = entries.findIndex((e) => e.season === s);
      const upd = {
        ...(idx >= 0 ? entries[idx] : {}),
        season: s,
        watched_at: v,
      };
      if (idx >= 0) entries[idx] = upd;
      else entries.push(upd);
      body.season_entries = entries;
    }
    body.season_dates = sdates;
    api(`/api/items/${it.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })
      .then((updated) => {
        Object.assign(it, updated);
        render();
      })
      .catch((err) => {
        toast(err.message, true);
        render();
      });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") return finish(false);
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

async function moveItem(it, from, to) {
  try {
    const updated = await api(`/api/items/${it.id}/move`, {
      method: "POST",
      body: JSON.stringify({ from, to }),
    });
    if (updated && !updated.deleted) Object.assign(it, updated);
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

function buildListMenu(menu, it) {
  const scored =
    it.kind === "movie" && (it.my_rating != null || it.di_rating != null);
  for (const n of listNames()) {
    if (n === "Spin") continue;
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = (it.lists || []).includes(n);
    cb.dataset.list = n;
    if (scored && (n === "Movies" || n === "No Di")) {
      cb.disabled = true;
      cb.title = "Already scored — this movie is seen, not to-watch";
    }
    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + n));
    menu.appendChild(label);
  }
  for (const cb of menu.querySelectorAll("input")) {
    cb.addEventListener("change", async () => {
      if (cb.checked && PRIMARY.has(cb.dataset.list)) {
        for (const o of menu.querySelectorAll("input")) {
          if (o !== cb && o.dataset.list && PRIMARY.has(o.dataset.list))
            o.checked = false;
        }
      }
      const lists = [...menu.querySelectorAll("input:checked")].map(
        (x) => x.dataset.list,
      );
      try {
        const updated = await api(`/api/items/${it.id}/lists`, {
          method: "PUT",
          body: JSON.stringify({ lists }),
        });
        if (updated && updated.deleted) {
          items = items.filter((x) => x.id !== it.id);
        } else if (updated) {
          Object.assign(it, updated);
        }
        menu.classList.add("hidden");
        const card = menu.closest(".card");
        if (card) {
          card.style.zIndex = "";
          card.style.opacity = "";
        }
        render();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }
}

function listNames() {
  const seen = new Set(TABS.map((t) => t.toLowerCase()));
  const extra = [];
  for (const it of items)
    for (const l of it.lists || [])
      if (!seen.has(l.toLowerCase())) {
        seen.add(l.toLowerCase());
        extra.push(l);
      }
  return [...TABS, ...extra.sort()];
}

function buildTabs() {
  const tabsEl = document.getElementById("tabs");
  tabsEl.innerHTML = "";
  const color = {
    Spin: "cspin",
    Leaderboard: "cspin",
    2026: "cwhite",
    "Currently Watching": "cwhite",
    Archive: "cwhite",
    "Taste Archive": "cwhite",
    "Movies Archive": "cwhite",
    "Shows Archive": "cwhite",
    ...Object.fromEntries(MOVIE_YEARS.map((y) => [y, "cwhite"])),
    ...Object.fromEntries(SHOW_YEARS.map((y) => [y, "cwhite"])),
    "Taste Movies": "cwhite",
    "Taste Shows": "cwhite",
    "Rewatch w/ Di": "cdi",
    Shows: "cdi",
    "Rewatch w/o Di": "cme",
    Movies: "cdi",
    "No Di": "cme",
    "Shows w/o Di": "cme",
  };
  const mk = (name) => {
    const b = document.createElement("button");
    b.className = ["tab-btn", color[name], name === list ? "active" : ""]
      .filter(Boolean)
      .join(" ");
    b.dataset.tab = name === "Spin" ? "spin" : name;
    b.textContent = name;
    return b;
  };
  const group = (cls, names) => {
    const g = document.createElement("div");
    g.className = "tab-group " + cls;
    for (const n of names) g.appendChild(mk(n));
    return g;
  };
  const rest = listNames().filter(
    (n) =>
      n !== "2026" &&
      n !== "Currently Watching" &&
      n !== "Taste Archive" &&
      !CATS.includes(n) &&
      !/^Archive \d{4}$/.test(n),
  );
  const purple = rest.filter((n) => color[n] === "cdi");
  const others = rest.filter((n) => color[n] !== "cdi");

  const catsEl = document.getElementById("cats");
  catsEl.innerHTML = "";
  const buildDrop = (label, items) => {
    const drop = document.createElement("div");
    drop.className = "cats-drop";
    const trig = mk(label);
    trig.classList.add("cats-trigger");
    trig.textContent = label + " ▾";
    drop.appendChild(trig);
    const menu = document.createElement("div");
    menu.className = "drop-menu hidden";
    for (const n of items) {
      const b = mk(n);
      b.classList.add("drop-item");
      menu.appendChild(b);
    }
    drop.appendChild(menu);
    catsEl.appendChild(drop);
  };
  buildDrop("Movies Archive", [...MOVIE_YEARS, "Taste Movies"]);
  buildDrop("Shows Archive", [...SHOW_YEARS, "Taste Shows"]);

  tabsEl.appendChild(group("left", ["Spin", "Leaderboard"]));
  tabsEl.appendChild(group("mid", ["2026", "Currently Watching"]));

  const right = document.createElement("div");
  right.className = "tab-group right";
  for (const n of purple) right.appendChild(mk(n));
  const sep = document.createElement("span");
  sep.className = "tab-sep";
  right.appendChild(sep);
  for (const n of others) right.appendChild(mk(n));
  tabsEl.appendChild(right);
}

function itemCats(it) {
  const out = new Set();
  for (const g of (it.genres || "").split(",")) {
    const c = GENRE_MAP[g.trim()];
    if (c) out.add(c);
  }
  return [...out];
}

function provKey(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("hbo")) return "hbo";
  if (n.includes("tubi")) return "tubi";
  if (n.includes("disney")) return "disney";
  if (n.includes("netflix")) return "netflix";
  return "";
}

function buildGenres(src) {
  const bar = document.getElementById("genre-bar");
  bar.innerHTML = "";
  const seen = [];
  const have = new Set();
  for (const it of items) {
    if (!(it.lists || []).includes(src)) continue;
    for (const c of itemCats(it)) {
      if (!have.has(c)) {
        have.add(c);
        seen.push(c);
      }
    }
  }
  seen.sort();
  const drop = (kind, label, open, build) => {
    const wrap = document.createElement("div");
    wrap.className = "cats-drop filter-drop";
    const trig = document.createElement("button");
    trig.className = "tab-btn cats-trigger filter-trigger";
    trig.dataset.drop = kind;
    trig.textContent = label + " ▾";
    wrap.appendChild(trig);
    const menu = document.createElement("div");
    menu.className = "drop-menu filter-menu" + (open ? "" : " hidden");
    build(menu);
    wrap.appendChild(menu);
    bar.appendChild(wrap);
  };
  const chip = (menu, label, cls, key, val, on) => {
    const b = document.createElement("button");
    b.className = cls + (on ? " on" : "");
    b.dataset[key] = val;
    b.textContent = label;
    menu.appendChild(b);
  };
  drop(
    "genre",
    (genreSel[src] || []).length ? `Genre (${genreSel[src].length})` : "Genre",
    genreOpen,
    (menu) => {
      chip(
        menu,
        "All",
        "genre-chip",
        "genre",
        "All",
        !(genreSel[src] || []).length,
      );
      for (const g of seen)
        chip(
          menu,
          g,
          "genre-chip",
          "genre",
          g,
          (genreSel[src] || []).includes(g),
        );
    },
  );
  drop(
    "provider",
    provSel.length ? `Provider (${provSel.length})` : "Provider",
    provOpen,
    (menu) => {
      chip(menu, "All", "prov-chip", "prov", "All", !provSel.length);
      for (const p of PROVS)
        chip(
          menu,
          p.label,
          "prov-chip",
          "prov",
          p.key,
          provSel.includes(p.key),
        );
      // Toggle to surface only very short titles (e.g. the movie "X"), handy when a
      // short name is hard to pull out of a title-contains search.
      const shortBtn = document.createElement("button");
      shortBtn.className =
        "tab-btn filter-trigger short-toggle" + (shortOnly ? " on" : "");
      shortBtn.textContent = `Short (≤${SHORT_MAX})`;
      shortBtn.title =
        "Show only titles with " + SHORT_MAX + " characters or fewer";
      shortBtn.addEventListener("click", () => {
        shortOnly = !shortOnly;
        render();
      });
      bar.appendChild(shortBtn);
    },
  );
  drop(
    "sort",
    sortSel[src] && sortSel[src] !== "default"
      ? `Sort: ${SORTS[sortSel[src]]}`
      : "Sort",
    sortOpen,
    (menu) => {
      for (const [k, label] of Object.entries(SORTS))
        chip(
          menu,
          label,
          "sort-chip",
          "sort",
          k,
          (sortSel[src] || "default") === k,
        );
    },
  );
}

function bestTab(x) {
  return (
    ["2026", "Movies", "No Di"].find((p) => (x.lists || []).includes(p)) ||
    (x.lists || [])[0] ||
    list
  );
}

function render() {
  const tabsEl = document.getElementById("tabs");
  const catsEl = document.getElementById("cats");
  for (const el of [tabsEl, catsEl])
    el.querySelectorAll(".tab-btn").forEach((b) => {
      const on = b.classList.contains("cats-trigger")
        ? b.dataset.tab === "Movies Archive"
          ? [...MOVIE_YEARS, "Taste Movies"].includes(list)
          : [...SHOW_YEARS, "Taste Shows"].includes(list)
        : b.dataset.tab === list;
      b.classList.toggle("active", on);
    });
  const slotView = document.getElementById("slot-view");
  const boardView = document.getElementById("board-view");
  const genreBar = document.getElementById("genre-bar");
  const spin = list === "spin";
  const board = list === "Leaderboard";
  tabSearchWrap.classList.toggle("hidden", spin || board);
  if (spin) {
    itemsEl.classList.add("hidden");
    emptyEl.classList.add("hidden");
    genreBar.classList.add("hidden");
    slotView.classList.remove("hidden");
    boardView.classList.add("hidden");
    buildDash();
    countEl.textContent = `${dashPool().length} titles`;
    return;
  }
  if (board) {
    itemsEl.classList.add("hidden");
    emptyEl.classList.add("hidden");
    genreBar.classList.add("hidden");
    slotView.classList.add("hidden");
    boardView.classList.remove("hidden");
    buildBoard();
    countEl.textContent = "";
    return;
  }
  genreBar.classList.remove("hidden");
  slotView.classList.add("hidden");
  boardView.classList.add("hidden");
  itemsEl.classList.remove("hidden");
  buildGenres(list);
  const q = tabQuery.trim().toLowerCase();
  const gs = genreSel[list] || [];
  let shown = items.filter((x) => (x.lists || []).includes(list));
  if (list === "Shows Archive") {
    const seen = new Set(shown.map((x) => x.id));
    for (const x of items) {
      if (
        !seen.has(x.id) &&
        x.kind === "tv" &&
        seasonsOf(x).some((s) => seasonArchived(x, s))
      ) {
        shown.push(x);
        seen.add(x.id);
      }
    }
  }
  if (q) {
    shown = items.filter((x) => (x.title || "").toLowerCase().includes(q));
    shown.sort((a, b) => a.title.localeCompare(b.title));
  } else {
    if (gs.length)
      shown = shown.filter((x) => gs.some((g) => itemCats(x).includes(g)));
    if (provSel.length)
      shown = shown.filter((x) =>
        (x.providers || []).some((p) => provSel.includes(provKey(p.name))),
      );
    if (shortOnly)
      shown = shown.filter((x) => (x.title || "").trim().length <= SHORT_MAX);
    const sort = sortSel[list] || "default";
    if (sort !== "default") {
      shown.sort((a, b) => {
        if (sort === "year_desc" || sort === "year_asc") {
          const ya = parseInt(a.year || "0", 10) || 0;
          const yb = parseInt(b.year || "0", 10) || 0;
          if (ya !== yb) return sort === "year_desc" ? yb - ya : ya - yb;
          return a.title.localeCompare(b.title);
        }
        if (sort === "name_asc") return a.title.localeCompare(b.title);
        if (sort === "name_desc") return b.title.localeCompare(a.title);
        return 0;
      });
    } else {
      const rev = list === "Currently Watching";
      shown.sort((a, b) => {
        if (list === "2026") {
          if (!a.watched_at && !b.watched_at) return 0;
          if (!a.watched_at) return 1;
          if (!b.watched_at) return -1;
          return b.watched_at.localeCompare(a.watched_at);
        }
        const pa =
          a.positions && a.positions[list] != null ? a.positions[list] : null;
        const pb =
          b.positions && b.positions[list] != null ? b.positions[list] : null;
        if (pa == null && pb == null)
          return rev
            ? (a.created_at || "").localeCompare(b.created_at || "")
            : (b.created_at || "").localeCompare(a.created_at || "");
        if (pa == null) return 1;
        if (pb == null) return -1;
        return rev ? pb - pa : pa - pb;
      });
      // Diana-confirmed titles sink to the bottom. Positions are untouched,
      // so unmarking restores the normal spot automatically.
      const open = shown.filter((x) => !x.di_confirmed);
      const done = shown.filter((x) => x.di_confirmed);
      if (done.length && open.length) shown = [...open, ...done];
    }
  }
  const isShowsYear = /^Shows \d{4}$/.test(list);
  const year = isShowsYear ? list.split(" ")[1] : null;
  if (isShowsYear && !q) {
    const sort = sortSel[list] || "default";
    if (sort !== "default") {
      shown.sort((a, b) => {
        if (sort === "year_desc" || sort === "year_asc") {
          const ya = parseInt(a.year || "0", 10) || 0;
          const yb = parseInt(b.year || "0", 10) || 0;
          if (ya !== yb) return sort === "year_desc" ? yb - ya : ya - yb;
          return a.title.localeCompare(b.title);
        }
        if (sort === "name_asc") return a.title.localeCompare(b.title);
        if (sort === "name_desc") return b.title.localeCompare(a.title);
        return 0;
      });
    } else {
      shown.sort((a, b) => {
        const ad =
          (a.season_dates &&
            a.current_season &&
            a.season_dates[a.current_season]?.finished_at) ||
          a.watched_at ||
          a.ep_finished_at ||
          "";
        const bd =
          (b.season_dates &&
            b.current_season &&
            b.season_dates[b.current_season]?.finished_at) ||
          b.watched_at ||
          b.ep_finished_at ||
          "";
        if (ad && bd) return bd.localeCompare(ad);
        if (ad) return -1;
        if (bd) return 1;
        const pa =
          a.positions && a.positions[list] != null ? a.positions[list] : null;
        const pb =
          b.positions && b.positions[list] != null ? b.positions[list] : null;
        if (pa == null && pb == null)
          return (b.created_at || "").localeCompare(a.created_at || "");
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pa - pb;
      });
    }
  }
  let expandedCount = shown.length;
  if (isShowsYear && !q) {
    expandedCount = 0;
    for (const it of shown) {
      if (it.kind !== "tv") expandedCount += 1;
      else {
        const seasons = seasonsOf(it);
        const rel = seasons.filter((s) => {
          const e = (it.season_entries || []).find((x) => x.season === s);
          const d = (it.season_dates || {})[s] || {};
          return (
            (e && e.watched_at && String(e.watched_at).startsWith(year)) ||
            (d.finished_at && String(d.finished_at).startsWith(year)) ||
            (d.started_at && String(d.started_at).startsWith(year))
          );
        });
        const toShow = rel.length
          ? rel
          : seasons.filter((s) =>
              (it.season_entries || []).some(
                (e) =>
                  e.season === s &&
                  (e.my_rating != null || e.di_rating != null),
              ),
            );
        expandedCount += toShow.length || 1;
      }
    }
  }
  countEl.textContent = q
    ? `${shown.length} match${shown.length === 1 ? "" : "es"} across all tabs`
    : `${expandedCount} in "${list}"`;
  itemsEl.innerHTML = "";
  if (isShowsYear) {
    const y = list.split(" ")[1];
    for (const it of shown) {
      if (it.kind !== "tv") {
        itemsEl.appendChild(card(it, list, !!q));
        continue;
      }
      const seasons = seasonsOf(it);
      const relevant = seasons.filter((s) => {
        const e = (it.season_entries || []).find((x) => x.season === s);
        const d = (it.season_dates || {})[s] || {};
        return (
          (e && e.watched_at && String(e.watched_at).startsWith(y)) ||
          (d.finished_at && String(d.finished_at).startsWith(y)) ||
          (d.started_at && String(d.started_at).startsWith(y))
        );
      });
      const toShow = relevant.length
        ? relevant
        : seasons.filter((s) =>
            (it.season_entries || []).some(
              (e) =>
                e.season === s && (e.my_rating != null || e.di_rating != null),
            ),
          );
      if (!toShow.length) {
        itemsEl.appendChild(card(it, list, !!q));
      } else {
        for (const s of toShow)
          itemsEl.appendChild(seasonCard(it, s, it.current_season, list));
      }
    }
  } else if (list === "Currently Watching") {
    const diItems = shown.filter((it) => (it.pinned || 0) >= 1);
    let rest = shown.filter((it) => (it.pinned || 0) < 1);
    if (justUnpinned) {
      const u = rest.find((it) => it.id === justUnpinned);
      if (u) rest = [u, ...rest.filter((it) => it.id !== justUnpinned)];
    }
    if (diItems.length) {
      const diBlock = document.createElement("div");
      diBlock.className = "diana-block";
      for (const it of diItems)
        diBlock.appendChild(card(it, q ? bestTab(it) : list, !!q));
      itemsEl.appendChild(diBlock);
    }
    for (const it of rest)
      itemsEl.appendChild(card(it, q ? bestTab(it) : list, !!q));
  } else {
    for (const it of shown)
      itemsEl.appendChild(card(it, q ? bestTab(it) : list, !!q));
  }
  justUnpinned = null;
  const provLabels = provSel
    .map((k) => PROVS.find((p) => p.key === k)?.label)
    .filter(Boolean);
  const filters = [...gs, ...provLabels, ...(shortOnly ? ["Short"] : [])].join(
    " + ",
  );
  emptyEl.textContent = q
    ? `No "${tabQuery.trim()}" matches anywhere.`
    : (gs.length || provSel.length) && shown.length === 0
      ? `No "${filters}" titles in "${list}".`
      : `Nothing in "${list}" yet. Add titles to the "${list}" tab in the spreadsheet and run Sync.`;
  emptyEl.classList.toggle("hidden", shown.length > 0);
}

async function load() {
  try {
    items = await api("/api/items");
    buildTabs();
    const names = [
      ...document.getElementById("tabs").querySelectorAll(".tab-btn"),
      ...document.getElementById("cats").querySelectorAll(".tab-btn"),
    ].map((b) => b.dataset.tab);
    if (!names.includes(list)) list = names[0];
    render();
  } catch (err) {
    toast(`Can't reach server: ${err.message}`, true);
  }
}

function setList(name) {
  list = name;
  tabQuery = "";
  tabSearchEl.value = "";
  genreOpen = false;
  provOpen = false;
}

document.getElementById("tabs").addEventListener("click", (e) => {
  const b = e.target.closest(".tab-btn");
  if (!b) return;
  setList(b.dataset.tab);
  render();
});

document.getElementById("cats").addEventListener("click", (e) => {
  const b = e.target.closest(".tab-btn");
  if (!b) return;
  if (b.classList.contains("cats-trigger")) {
    const menu = b.closest(".cats-drop").querySelector(".drop-menu");
    if (menu) menu.classList.toggle("hidden");
    return;
  }
  setList(b.dataset.tab);
  document
    .querySelectorAll(".drop-menu")
    .forEach((m) => m.classList.add("hidden"));
  render();
});

tabSearchEl.addEventListener("input", () => {
  tabQuery = tabSearchEl.value;
  render();
});

tabSearchClear.addEventListener("click", () => {
  tabQuery = "";
  tabSearchEl.value = "";
  render();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".cats-drop")) {
    document
      .querySelectorAll(".drop-menu")
      .forEach((m) => m.classList.add("hidden"));
    genreOpen = false;
    provOpen = false;
    sortOpen = false;
  }
});

document.getElementById("genre-bar").addEventListener("click", (e) => {
  const trig = e.target.closest(".filter-trigger");
  if (trig) {
    if (trig.dataset.drop === "genre") genreOpen = !genreOpen;
    else if (trig.dataset.drop === "provider") provOpen = !provOpen;
    else if (trig.dataset.drop === "sort") sortOpen = !sortOpen;
    buildGenres(list);
    return;
  }
  const chip = e.target.closest(".genre-chip");
  if (chip) {
    const sel = genreSel[list] || [];
    if (chip.dataset.genre === "All") {
      genreSel[list] = [];
    } else {
      const g = chip.dataset.genre;
      genreSel[list] = sel.includes(g)
        ? sel.filter((x) => x !== g)
        : [...sel, g];
    }
    render();
    return;
  }
  const pc = e.target.closest(".prov-chip");
  if (pc) {
    const k = pc.dataset.prov;
    provSel =
      k === "All"
        ? []
        : provSel.includes(k)
          ? provSel.filter((x) => x !== k)
          : [...provSel, k];
    render();
    return;
  }
  const sc = e.target.closest("[data-sort]");
  if (sc) {
    sortSel[list] = sc.dataset.sort;
    localStorage.setItem("sortSel", JSON.stringify(sortSel));
    render();
  }
});

document.getElementById("kind-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".kind-btn");
  if (!btn) return;
  document
    .querySelectorAll(".kind-btn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  kind = btn.dataset.kind;
  searchInput.placeholder =
    kind === "notes"
      ? "Search your reviews and notes..."
      : "Search movies or shows...";
});

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch],
  );
}

function tasteHref(it) {
  return `/api/taste/url?title=${encodeURIComponent(it.title)}&kind=${it.kind}&year=${encodeURIComponent(it.year || "")}`;
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest(".taste-link");
  if (!a) return;
  e.preventDefault();
  const url =
    a.dataset.href ||
    tasteHref({
      title: a.dataset.title,
      kind: a.dataset.kind,
      year: a.dataset.year,
    });
  try {
    const r = await fetch(url);
    const j = await r.json();
    window.open(j.url, "_blank", "noopener");
  } catch {
    window.open(
      `https://www.taste.io/search?q=${encodeURIComponent(a.dataset.title)}`,
      "_blank",
      "noopener",
    );
  }
});

function focusItem(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  const target = bestTab(it);
  setList(target);
  genreSel[target] = [];
  provSel = [];
  render();
  requestAnimationFrame(() => {
    const el = itemsEl.querySelector(`.card[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1500);
  });
  resultsEl.classList.add("hidden");
  resultsHidden = true;
}

function renderSearchResults(results) {
  resultsEl.classList.remove("hidden");
  resultsEl.innerHTML = "";
  if (!results.length) {
    resultsEl.textContent = "No results.";
    return;
  }
  const head = document.createElement("div");
  head.className = "results-head";
  head.innerHTML = `<span>Results (click to add)</span><button id="close-results">✕</button>`;
  resultsEl.appendChild(head);
  resultsEl.querySelector("#close-results").addEventListener("click", () => {
    resultsEl.classList.add("hidden");
    resultsHidden = true;
  });
  for (const r of results) {
    const b = document.createElement("div");
    b.className = "result";
    const p = r.poster
      ? `<img class="result-poster" src="${r.poster}" alt="" onerror="this.style.visibility='hidden'" />`
      : `<div class="result-poster placeholder">${esc(r.title[0] || "")}</div>`;
    b.innerHTML = `${p}<span class="result-info"><strong>${esc(r.title)}</strong><span>${esc(r.year || "")}</span><span class="result-genres">${esc(r.genres || "")}</span></span>`;
    b.addEventListener("click", async (e) => {
      if (b.querySelector(".result-season")) return;
      if (r.kind !== "tv") return addFromResult(r);
      try {
        const data = await api(`/api/seasons?tmdb_id=${r.tmdb_id}&kind=tv`);
        const seasons =
          data.seasons && data.seasons.length
            ? data.seasons
            : [{ season: 1, episodes: null }];
        b.innerHTML = `${p}<span class="result-info"><strong>${esc(r.title)}</strong><span>Pick a season</span></span>`;
        const sel = document.createElement("select");
        sel.className = "result-season";
        for (const sn of seasons) {
          const o = document.createElement("option");
          o.value = String(sn.season);
          o.textContent = `S${sn.season}${sn.episodes ? " · " + sn.episodes + " ep" : ""}`;
          sel.appendChild(o);
        }
        sel.addEventListener("click", (e) => e.stopPropagation());
        sel.addEventListener("mousedown", (e) => e.stopPropagation());
        const add = document.createElement("button");
        add.className = "result-add";
        add.textContent = "Add";
        add.addEventListener("click", (e) => {
          e.stopPropagation();
          addFromResult(r, Number(sel.value));
        });
        b.appendChild(sel);
        b.appendChild(add);
      } catch (err) {
        toast(err.message, true);
      }
    });
    resultsEl.appendChild(b);
  }
}

async function addFromResult(r, season) {
  try {
    const body = { tmdb_id: r.tmdb_id, kind: r.kind };
    if (list && list !== "spin") body.list = list;
    if (season) body.season = season;
    const added = await api("/api/items", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await load();
    toast(`Added "${added.title}"`);
    resultsEl.classList.add("hidden");
    resultsHidden = true;
    searchInput.value = "";
  } catch (err) {
    toast(err.message, true);
  }
}

function markSnippet(text, q) {
  const low = text.toLowerCase();
  const i = low.indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  const a = Math.max(0, i - 45);
  const b = Math.min(text.length, i + q.length + 45);
  return (
    (a > 0 ? "…" : "") +
    esc(text.slice(a, i)) +
    "<mark>" +
    esc(text.slice(i, i + q.length)) +
    "</mark>" +
    esc(text.slice(i + q.length, b)) +
    (b < text.length ? "…" : "")
  );
}

function renderNotesResults(results, q) {
  resultsEl.classList.remove("hidden");
  resultsEl.innerHTML = "";
  if (!results.length) {
    resultsEl.textContent = "No notes match.";
    return;
  }
  const head = document.createElement("div");
  head.className = "results-head";
  head.innerHTML = `<span>Notes (click to open)</span><button id="close-results">✕</button>`;
  resultsEl.appendChild(head);
  resultsEl.querySelector("#close-results").addEventListener("click", () => {
    resultsEl.classList.add("hidden");
    resultsHidden = true;
  });
  for (const r of results) {
    const b = document.createElement("button");
    b.className = "result";
    const where = (r.hits || [])
      .map((h) => `<span class="note-where">${esc(h.where)}</span>`)
      .join("");
    const snips = (r.hits || [])
      .map(
        (h) => `<span class="note-snippet">${markSnippet(h.snippet, q)}</span>`,
      )
      .join("");
    b.innerHTML = `<span class="result-info notes-result"><strong>${esc(r.title)}${r.year ? ` <em>(${esc(r.year)})</em>` : ""}</strong>${where}${snips}</span>`;
    b.addEventListener("click", () => focusItem(r.id));
    resultsEl.appendChild(b);
  }
}

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  resultsHidden = false;
  try {
    if (kind === "notes") {
      const data = await api(`/api/notes?q=${encodeURIComponent(q)}`);
      renderNotesResults(data.results || [], q);
    } else {
      const data = await api(
        `/api/search?q=${encodeURIComponent(q)}&kind=${kind}`,
      );
      renderSearchResults(data.results || []);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

searchBtn.addEventListener("click", doSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

function openScoreInline(btn, it, season = null) {
  const entry =
    season != null
      ? (it.season_entries || []).find((e) => e.season === season)
      : null;
  const val = (f) => (season != null ? (entry && entry[f]) || "" : it[f] || "");
  const wrap = document.createElement("div");
  wrap.className = "score-inline";
  wrap.innerHTML = `
    <label class="score-field"><span>J</span><input type="number" min="1" max="100" inputmode="numeric" placeholder="1–100" value="${val("my_rating")}" /></label>
    <label class="score-field"><span>D</span><input type="number" min="1" max="100" inputmode="numeric" placeholder="1–100" value="${val("di_rating")}" /></label>
  `;
  btn.replaceWith(wrap);
  const inputs = wrap.querySelectorAll("input");
  inputs[0].focus();
  inputs[0].select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (!save) return render();
    const num = (v) => {
      const n = Number(v);
      if (!v || !Number.isFinite(n)) return null;
      return Math.min(100, Math.max(1, Math.round(n)));
    };
    const my = num(inputs[0].value);
    const di = num(inputs[1].value);
    const body = season != null ? {} : { my_rating: my, di_rating: di };
    if (season != null) {
      const entries = [...(it.season_entries || [])];
      const idx = entries.findIndex((e) => e.season === season);
      const upd = {
        ...(idx >= 0 ? entries[idx] : {}),
        season,
        my_rating: my,
        di_rating: di,
      };
      if (idx >= 0) entries[idx] = upd;
      else entries.push(upd);
      body.season_entries = entries;
    }
    const ls = it.lists || [];
    if (
      it.kind === "movie" &&
      (ls.includes("Movies") || ls.includes("No Di")) &&
      (my != null || di != null)
    )
      body.move_to_2026 = true;
    api(`/api/items/${it.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    })
      .then((updated) => {
        Object.assign(it, updated);
        render();
      })
      .catch((err) => {
        toast(err.message, true);
        render();
      });
  };
  for (const input of inputs) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return finish(false);
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
    });
    input.addEventListener("blur", (e) => {
      if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
      finish(true);
    });
  }
}

const reelTitle = document.getElementById("reel-title");
const reelYear = document.getElementById("reel-year");
const reelGenre = document.getElementById("reel-genre");
const slotResult = document.getElementById("slot-result");
const nightBtn = document.getElementById("night-btn");
const nightGenre = document.getElementById("night-genre");
const nightResult = document.getElementById("night-result");

function dashPool() {
  return items.filter((x) => (x.lists || []).includes(spinList));
}

function genreCounts(pool) {
  const out = {};
  for (const it of pool)
    for (const c of itemCats(it)) out[c] = (out[c] || 0) + 1;
  return out;
}

function buildDash() {
  const counts = {};
  for (const it of items)
    for (const l of it.lists || []) counts[l] = (counts[l] || 0) + 1;
  for (const b of document.querySelectorAll(".dash-mode-btn")) {
    b.classList.toggle("on", b.dataset.list === spinList);
    b.textContent = `${b.dataset.list} (${counts[b.dataset.list] || 0})`;
  }

  const pool = dashPool();
  const cats = Object.entries(genreCounts(pool)).sort((a, b) => b[1] - a[1]);
  const sel = document.getElementById("dash-genre-select");
  sel.innerHTML = "";
  const any = document.createElement("option");
  any.value = "";
  any.textContent = `Any genre (${pool.length})`;
  sel.appendChild(any);
  for (const [name, count] of cats) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = `${name} (${count})`;
    sel.appendChild(o);
  }
}

function buildBoard() {
  const year = "2026";
  const ratingFor = (it, key) => {
    if (it[key] != null) return it[key];
    if (it.kind === "tv" && it.season_entries) {
      const se = it.season_entries.find(
        (e) =>
          e[key] != null &&
          ((it.season_dates &&
            it.season_dates[e.season] &&
            (it.season_dates[e.season].finished_at || "").startsWith(year)) ||
            (e.watched_at || "").startsWith(year)),
      );
      if (se) return se[key];
      const any = it.season_entries.find((e) => e[key] != null);
      if (any) return any[key];
    }
    return null;
  };
  const topFor = (key, kind) =>
    items
      .filter((x) => {
        if (x.kind !== kind) return false;
        const watchedYear =
          (x.watched_at || "").startsWith(year) ||
          (x.season_dates &&
            Object.values(x.season_dates).some((d) =>
              (d.finished_at || "").startsWith(year),
            ));
        if (!watchedYear) return false;
        return ratingFor(x, key) != null;
      })
      .sort((a, b) => (ratingFor(b, key) || 0) - (ratingFor(a, key) || 0))
      .slice(0, 10);
  const fillTop = (elId, key, kind) => {
    const el = document.getElementById(elId);
    if (!el) return;
    const top = topFor(key, kind);
    el.innerHTML = top.length
      ? top
          .map((it) => {
            const r = ratingFor(it, key);
            const isSeason = it.kind === "tv" && it[key] == null;
            const label = isSeason
              ? `${esc(it.title)} S${(it.season_entries.find((e) => e[key] != null) || {}).season || ""}`
              : esc(it.title);
            return `<li>${label} <small style="color:var(--text2)">— ${r}</small></li>`;
          })
          .join("")
      : '<li style="color:var(--text2)">No ratings yet</li>';
  };
  fillTop("top-james-movies", "my_rating", "movie");
  fillTop("top-diana-movies", "di_rating", "movie");
  fillTop("top-james-shows", "my_rating", "tv");
  fillTop("top-diana-shows", "di_rating", "tv");
}

function slotSymbols(pool) {
  const rand = () => pool[Math.floor(Math.random() * pool.length)];
  return {
    title: () => rand().title,
    year: () => rand().year || "????",
    genre: () => {
      const c = itemCats(rand());
      return c[0] || rand().genres || "—";
    },
  };
}

function reveal(winner) {
  const c = itemCats(winner);
  const g = c[0] || winner.genres || "";
  const p = winner.poster
    ? `<img class="poster" src="${winner.poster}" alt="" onerror="this.style.visibility='hidden'" />`
    : `<div class="poster placeholder">${(winner.title[0] || "").toUpperCase()}</div>`;
  slotResult.innerHTML = `${p}
    <div class="slot-win">
      <strong>${winner.title}</strong>
      <span class="slot-tag">${winner.year || ""}${g ? " · " + g : ""}${winner.kind === "tv" ? " · Show" : ""}</span>
      ${refLine(winner)}
    </div>`;
  slotResult.classList.remove("hidden");
}

function runReels(winner, pool) {
  const sym = slotSymbols(pool);
  const c = itemCats(winner);
  const finals = [
    winner.title,
    winner.year || "????",
    c[0] || winner.genres || "—",
  ];
  const reels = [
    { el: reelTitle, get: sym.title },
    { el: reelYear, get: sym.year },
    { el: reelGenre, get: sym.genre },
  ];
  slotResult.classList.add("hidden");
  slotResult.innerHTML = "";
  const times = [900, 1300, 1700];
  let done = 0;
  for (let i = 0; i < reels.length; i++) {
    const el = reels[i].el;
    const get = reels[i].get;
    el.classList.add("spinning");
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (list !== "spin") {
        clearInterval(iv);
        return;
      }
      if (performance.now() - t0 >= times[i]) {
        clearInterval(iv);
        el.classList.remove("spinning");
        el.textContent = finals[i];
        if (++done === reels.length) reveal(winner);
        return;
      }
      el.textContent = get();
    }, 45);
  }
}

function spinDash(genre) {
  const pool = genre
    ? dashPool().filter((x) => itemCats(x).includes(genre))
    : dashPool();
  if (!pool.length) {
    toast(
      genre ? `No "${genre}" titles in this pool.` : "Nothing to spin.",
      true,
    );
    return;
  }
  nightResult.classList.add("hidden");
  nightGenre.textContent = "";
  runReels(pool[Math.floor(Math.random() * pool.length)], pool);
}

function pickTitles(pool, genre, n) {
  const arr = pool.filter((x) => itemCats(x).includes(genre));
  const out = [];
  while (out.length < n && arr.length) {
    out.push(arr.splice(Math.floor(Math.random() * arr.length), 1)[0]);
  }
  return out;
}

function genreNight() {
  const pool = dashPool();
  if (!pool.length) {
    toast("Nothing to pick from. Add titles first.", true);
    return;
  }
  const cats = Object.keys(genreCounts(pool));
  if (!cats.length) {
    toast("No genres in this pool.", true);
    return;
  }
  const genre = cats[Math.floor(Math.random() * cats.length)];
  const lineup = pickTitles(pool, genre, 3);
  nightBtn.disabled = true;
  nightResult.classList.add("hidden");
  nightResult.innerHTML = "";
  nightGenre.textContent = "";
  nightGenre.classList.add("spinning");
  const t0 = performance.now();
  const iv = setInterval(() => {
    if (list !== "spin") {
      clearInterval(iv);
      return;
    }
    if (performance.now() - t0 >= 1100) {
      clearInterval(iv);
      nightGenre.classList.remove("spinning");
      nightGenre.textContent = `${genre} Night`;
      for (const it of lineup) {
        const c = itemCats(it);
        const g = c[0] || it.genres || "";
        const p = it.poster
          ? `<img class="poster" src="${it.poster}" alt="" onerror="this.style.visibility='hidden'" />`
          : `<div class="poster placeholder">${(it.title[0] || "").toUpperCase()}</div>`;
        const row = document.createElement("div");
        row.className = "night-row";
        row.innerHTML = `${p}
          <div>
            <strong>${it.title}</strong>
            <span class="slot-tag">${it.year || ""}${g ? " · " + g : ""}${it.kind === "tv" ? " · Show" : ""}</span>
            ${refLine(it)}
          </div>`;
        nightResult.appendChild(row);
      }
      nightResult.classList.remove("hidden");
      nightBtn.disabled = false;
      return;
    }
    nightGenre.textContent = cats[Math.floor(Math.random() * cats.length)];
  }, 60);
}

document.getElementById("dash-mode").addEventListener("click", (e) => {
  const b = e.target.closest(".dash-mode-btn");
  if (!b) return;
  spinList = b.dataset.list;
  buildDash();
  countEl.textContent = `${dashPool().length} titles`;
});
document.getElementById("dash-spin-btn").addEventListener("click", () => {
  spinDash(document.getElementById("dash-genre-select").value);
});
nightBtn.addEventListener("click", genreNight);

const backTop = document.getElementById("back-top");
const onScroll = () => backTop.classList.toggle("hidden", window.scrollY < 300);
addEventListener("scroll", onScroll, { passive: true });
onScroll();
backTop.addEventListener("click", () =>
  scrollTo({ top: 0, behavior: "smooth" }),
);

load();
