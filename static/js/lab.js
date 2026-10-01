/**
 * SemAtlas Lab: the course on the map.
 *
 * Reads /learn/bridge.json (which Wikipedia article each concept taught on
 * learn.sematlas.com is) and /learn/frontier.json (what lies just beyond, and
 * the links between taught concepts), both built by scripts in this repo.
 *
 * Taught concepts are boxes coloured by deck, pulled into lanes left to right
 * in course order. Articles beyond the course are dashed boxes placed near the
 * concepts that point to them: foundations to the left of those concepts,
 * next steps to the right.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => document.documentElement.getAttribute("data-theme") !== "light";
const short = (t) => t.replace(/ \(.*\)$/, "");

// one hue per deck, in course order (validated categorical palette)
const HUES = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
};
const LANE = 320;

const state = { taught: [], beyond: [], decks: [], frontier: [], edges: [], filter: "all" };
let nodes = [], links = [], byId = new Map();

const svg = d3.select("#tree");
const root = svg.append("g");
const linkLayer = root.append("g");
const nodeLayer = root.append("g");
const zoomer = d3.zoom().scaleExtent([0.15, 4]).on("zoom", (ev) => root.attr("transform", ev.transform));
svg.call(zoomer).on("dblclick.zoom", null);

const sim = d3.forceSimulation()
  .force("charge", d3.forceManyBody().strength(-120))
  .force("link", d3.forceLink().id((d) => d.id)
    .distance((l) => (l.kind === "beyond" ? 110 : 160))
    .strength((l) => (l.kind === "beyond" ? 0.25 : 0.015)))
  .force("x", d3.forceX((d) => d.tx).strength((d) => (d.kind === "taught" ? 0.6 : 0.25)))
  .force("y", d3.forceY(0).strength(0.03))
  .force("collide", rectCollide())
  .on("tick", ticked);

// boxes do not overlap (the same push the /q graph uses)
function rectCollide(padding = 5) {
  let ns = [];
  function force() {
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i];
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = (a.w + b.w) / 2 + padding - Math.abs(dx);
        const oy = (a.h + b.h) / 2 + padding - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy) { const m = ox / 4 * (dx < 0 ? -1 : 1); a.x -= m; b.x += m; }
          else { const m = oy / 4 * (dy < 0 ? -1 : 1); a.y -= m; b.y += m; }
        }
      }
    }
  }
  force.initialize = (n) => { ns = n; };
  return force;
}

function deckColor(deckIndex) {
  const h = HUES[isDark() ? "dark" : "light"];
  return h[deckIndex % h.length];
}

// ------------------------------------------------------------------ data

async function load() {
  const [bridge, frontier] = await Promise.all([
    fetch("/learn/bridge.json").then((r) => r.json()),
    fetch("/learn/frontier.json").then((r) => r.json()),
  ]);
  // one node per Wikipedia article; several concept keys can share one
  const art = new Map();
  Object.entries(bridge.concepts || {}).forEach(([key, c]) => {
    if (!c.wiki) return;
    const n = art.get(c.wiki) || { id: c.wiki, kind: "taught", keys: [], lessons: [], order: c.order };
    n.keys.push(key);
    n.lessons.push({ key, title: c.title, deck: c.deck, deck_title: c.deck_title, url: c.url, order: c.order });
    if (!n.order || c.order[0] < n.order[0] || (c.order[0] === n.order[0] && c.order[1] < n.order[1])) {
      n.order = c.order; n.deck = c.deck; n.deck_title = c.deck_title;
    }
    n.deck = n.deck || c.deck; n.deck_title = n.deck_title || c.deck_title;
    art.set(c.wiki, n);
  });
  state.taught = [...art.values()];
  const deckOrder = [...new Map(state.taught.map((n) => [n.deck, n.order[0]])).entries()]
    .sort((a, b) => a[1] - b[1]).map(([d]) => d);
  state.decks = deckOrder.map((d) => ({
    id: d, title: state.taught.find((n) => n.deck === d).deck_title,
  }));
  state.taught.forEach((n) => { n.lane = deckOrder.indexOf(n.deck); n.tx = n.lane * LANE; });

  const keyToWiki = {};
  Object.entries(bridge.concepts || {}).forEach(([k, c]) => { if (c.wiki) keyToWiki[k] = c.wiki; });
  state.keyToWiki = keyToWiki;
  state.frontier = frontier.frontier || [];
  state.edges = (frontier.edges || [])
    .map(([a, b]) => [keyToWiki[a], keyToWiki[b]]).filter(([a, b]) => a && b && a !== b);
  state.meta = frontier;

  const decksN = state.decks.length;
  $("stats").textContent =
    `${Object.keys(bridge.concepts || {}).length} concepts in ${decksN} decks, on ` +
    `${state.taught.length} Wikipedia articles · ${new Set(state.edges.map((e) => e.sort().join("|"))).size} ` +
    `links between them · ${state.frontier.length} articles just beyond` +
    (frontier.built ? ` · built ${frontier.built}` : "");
  $("method").textContent = frontier.method
    ? `How this was built: ${frontier.method} (model ${frontier.model}, $${frontier.cost_usd}).` : "";
  legend();
  build(+$("beyondN").value);
  renderList();
}

function build(nBeyond) {
  const old = new Map(nodes.map((n) => [n.id, n]));
  const beyond = state.frontier.slice(0, nBeyond).map((f) => {
    const near = f.near.map((k) => state.keyToWiki[k]).filter(Boolean);
    const lanes = near.map((w) => state.taught.find((t) => t.id === w)?.lane ?? 0);
    const lane = lanes.length ? lanes.reduce((a, b) => a + b, 0) / lanes.length : 0;
    return { id: "f:" + f.article, article: f.article, kind: "beyond", f, near,
             tx: lane * LANE + (f.role === "basis" ? -150 : 150) };
  });
  nodes = [...state.taught, ...beyond].map((n) => {
    const o = old.get(n.id);
    return Object.assign(n, o ? { x: o.x, y: o.y } : {
      x: n.tx + (Math.random() - 0.5) * 80, y: (Math.random() - 0.5) * 600,
    });
  });
  byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set();
  links = [];
  state.edges.forEach(([a, b]) => {
    const k = [a, b].sort().join("|");
    if (!seen.has(k) && byId.has(a) && byId.has(b)) { seen.add(k); links.push({ source: a, target: b, kind: "taught" }); }
  });
  beyond.forEach((n) => n.near.slice(0, 3).forEach((w) => {
    if (byId.has(w)) links.push({ source: n.id, target: w, kind: "beyond" });
  }));
  draw();
  sim.nodes(nodes);
  sim.force("link").links(links);
  sim.force("collide").initialize(nodes);
  sim.alpha(1).restart();
  setTimeout(fit, 1600);
}

// ------------------------------------------------------------------ drawing

function label(d) { return d.kind === "taught" ? short(d.id) : short(d.article); }

function draw() {
  linkLayer.selectAll("line")
    .data(links, (l) => `${l.source.id || l.source}|${l.target.id || l.target}`)
    .join("line").attr("class", (l) => "t-link " + l.kind);

  const g = nodeLayer.selectAll("g.t-node")
    .data(nodes, (d) => d.id)
    .join((enter) => {
      const e = enter.append("g").attr("class", (d) => "t-node " + d.kind);
      e.append("rect").attr("rx", 5);
      e.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").text(label);
      e.on("mouseenter", (ev, d) => { focus(d); showTip(ev, tip(d)); })
        .on("mousemove", moveTip)
        .on("mouseleave", () => { focus(null); hideTip(); })
        .on("click", (ev, d) => (d.kind === "taught" ? openLesson(d) : showCard(d)))
        .call(d3.drag()
          .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.1).restart(); d.fx = d.x; d.fy = d.y; })
          .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
          .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
      return e;
    });
  restyle();
}

function restyle() {
  const g = nodeLayer.selectAll("g.t-node");
  g.classed("named", (d) => d.kind === "beyond" && d.f.named_in.length > 0);
  g.select("text")
    .style("font-size", (d) => (d.kind === "taught" ? 15 : 12) + "px")
    .style("fill", (d) => {
      if (d.kind !== "taught") return css("--ink-dim");
      return d3.lab(deckColor(d.lane)).l > 60 ? "#12151b" : "#f4f6f9";
    });
  g.each(function (d) {
    const b = d3.select(this).select("text").node().getBBox();
    d.w = b.width + 14; d.h = b.height + 8;
  });
  g.select("rect")
    .attr("x", (d) => -d.w / 2).attr("y", (d) => -d.h / 2)
    .attr("width", (d) => d.w).attr("height", (d) => d.h)
    .style("fill", (d) => (d.kind === "taught" ? deckColor(d.lane) : css("--bg")))
    .style("stroke", (d) => (d.kind === "taught" ? "none" : css("--ink-dim")));
}

function ticked() {
  linkLayer.selectAll("line")
    .attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y)
    .attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y);
  nodeLayer.selectAll("g.t-node").attr("transform", (d) => `translate(${d.x},${d.y})`);
}

function fit() {
  if (!nodes.length) return;
  const el = svg.node(), w = el.clientWidth, h = el.clientHeight;
  const x0 = d3.min(nodes, (d) => d.x - d.w / 2), x1 = d3.max(nodes, (d) => d.x + d.w / 2);
  const y0 = d3.min(nodes, (d) => d.y - d.h / 2), y1 = d3.max(nodes, (d) => d.y + d.h / 2);
  const k = Math.min(w / (x1 - x0 + 60), h / (y1 - y0 + 60), 1.5);
  svg.transition().duration(600).call(zoomer.transform,
    d3.zoomIdentity.translate(w / 2 - k * (x0 + x1) / 2, h / 2 - k * (y0 + y1) / 2).scale(k));
}

function focus(d) {
  if (!d) {
    nodeLayer.selectAll("g.t-node").classed("dim", false).classed("hot", false);
    linkLayer.selectAll("line").classed("dim", false).classed("hot", false);
    return;
  }
  const near = new Set([d.id]);
  links.forEach((l) => {
    if (l.source.id === d.id) near.add(l.target.id);
    if (l.target.id === d.id) near.add(l.source.id);
  });
  nodeLayer.selectAll("g.t-node").classed("dim", (n) => !near.has(n.id)).classed("hot", (n) => n.id === d.id);
  linkLayer.selectAll("line")
    .classed("hot", (l) => l.source.id === d.id || l.target.id === d.id)
    .classed("dim", (l) => !(l.source.id === d.id || l.target.id === d.id));
}

function zoomTo(d) {
  const el = svg.node(), k = 1.2;
  svg.transition().duration(500).call(zoomer.transform,
    d3.zoomIdentity.translate(el.clientWidth / 2 - k * d.x, el.clientHeight / 2 - k * d.y).scale(k));
  focus(d);
  setTimeout(() => focus(null), 2600);
}

function legend() {
  $("legend").innerHTML = state.decks.map((d, i) =>
    `<span><i style="background:${deckColor(i)}"></i>${esc(d.title)}</span>`).join("") +
    `<span><i class="dash"></i>beyond the course</span>`;
}

// ------------------------------------------------------------------ details

function tip(d) {
  if (d.kind === "taught") {
    return `<b>${esc(d.id)}</b>` + d.lessons.map((l) =>
      `Taught in <i>${esc(l.title)}</i> (${esc(l.deck_title)})`).join("<br>") +
      "<br>Click to open the lesson.";
  }
  const f = d.f;
  return `<b>${esc(f.article)}</b>${f.about ? `<i>${esc(f.about)}</i><br>` : ""}` +
    `${f.role === "basis" ? "A foundation" : "A next step"} for ${esc(d.near.slice(0, 4).map(short).join(", "))}` +
    (f.named_in.length ? `<br>Named in the lesson title "${esc(f.named_in[0])}": possibly taught, not tagged.` : "") +
    "<br>Click for more.";
}

function showCard(d) {
  const f = d.f;
  const q = `What is ${short(f.article)}, and how does it connect to ${short(d.near[0] || "")}?`;
  $("card").innerHTML = `
    <button class="modal-x" type="button" aria-label="Close">×</button>
    <span class="card-kicker">${f.role === "basis" ? "A foundation the course rests on" : "Where the course leads"}</span>
    <h3>${esc(f.article)}</h3>
    ${f.about ? `<p class="card-about">${esc(f.about)}</p>` : ""}
    <p>Pointed to by ${d.near.length} taught concept${d.near.length === 1 ? "" : "s"}:
      ${d.near.map((w) => `<a href="#" data-w="${esc(w)}">${esc(short(w))}</a>`).join(", ")}.</p>
    ${f.named_in.length ? `<p class="card-named">Its name appears in the lesson title "${esc(f.named_in[0])}",
      so it may already be taught without a concept tag.</p>` : ""}
    <div class="card-actions">
      <a class="primary" href="/q?q=${encodeURIComponent(q)}" target="_blank" rel="noopener">Explore it on the map</a>
      <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(f.article.replace(/ /g, "_"))}"
         target="_blank" rel="noopener">Wikipedia</a>
    </div>`;
  $("card").hidden = false;
  $("card").querySelector(".modal-x").addEventListener("click", () => { $("card").hidden = true; });
  $("card").querySelectorAll("[data-w]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const n = byId.get(a.dataset.w);
    if (n) zoomTo(n);
  }));
}

function openLesson(d) {
  const l = d.lessons.slice().sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])[0];
  window.open(l.url, "_blank", "noopener");
}

function renderList() {
  const f = state.filter;
  const items = state.frontier.filter((x) =>
    f === "all" || (f === "named" ? x.named_in.length : x.role === f)).slice(0, 100);
  $("beyondList").innerHTML = items.map((x) => `
    <li data-a="${esc(x.article)}">
      <span class="b-name">${esc(x.article)}</span>
      <span class="b-score">${x.score.toFixed(1)}</span>
      <span class="b-near">${x.role === "basis" ? "foundation for" : "next after"}
        ${esc(x.near.slice(0, 3).map((k) => short(state.keyToWiki[k] || k)).join(", "))}</span>
    </li>`).join("");
  $("beyondList").querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
    const n = byId.get("f:" + li.dataset.a);
    if (n) { zoomTo(n); showCard(n); }
    else {   // not drawn at the current count: draw more, then go there
      $("beyondN").value = "160"; build(160);
      setTimeout(() => { const m = byId.get("f:" + li.dataset.a); if (m) { zoomTo(m); showCard(m); } }, 1800);
    }
  }));
}

// ------------------------------------------------------------------ tooltip

function showTip(ev, html) { const t = $("tip"); t.innerHTML = html; t.hidden = false; moveTip(ev); }
function moveTip(ev) {
  const t = $("tip");
  t.style.left = Math.min(ev.clientX + 14, innerWidth - t.offsetWidth - 8) + "px";
  t.style.top = Math.min(ev.clientY + 14, innerHeight - t.offsetHeight - 8) + "px";
}
function hideTip() { $("tip").hidden = true; }

// ------------------------------------------------------------------ page

$("fitBtn").addEventListener("click", fit);
$("beyondN").addEventListener("change", (e) => build(+e.target.value));
$("tabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("tabs").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  state.filter = b.dataset.f;
  renderList();
}));
$("themeBtn").addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("sa-theme", next); } catch (e) {}
  restyle(); legend();
});
addEventListener("keydown", (e) => { if (e.key === "Escape") $("card").hidden = true; });

load();
