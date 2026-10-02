/**
 * SemAtlas Lab: the course as a tree, on the map.
 *
 * Reads /learn/graph.json (scripts/build_graph.py): the concepts taught on
 * learn.sematlas.com with their lessons and prerequisite edges, Wikipedia's
 * links between them, the articles just beyond the course, and story decks.
 *
 * Layout: columns are prerequisite depth (a concept sits one column right of
 * the deepest thing it needs), rows are the parts of the course (one hue per
 * deck). Articles beyond the course sit left of the concepts they found and
 * right of the ones they follow.
 *
 * Two modes. Explore: hover traces a concept back to its basics and forward
 * to where it leads; click opens a card with its lesson and its place on the
 * map. Plan: click marks what you know; the tree shows what is ready next.
 * #c=<key> in the URL opens on a concept.
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => document.documentElement.getAttribute("data-theme") !== "light";

// one hue per deck, in course order (validated categorical palette)
const HUES = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
};
const COL = 250, ROW = 150;

const S = {
  graph: null, decks: [], beyond: [], filter: "all", plan: false,
  known: new Set(JSON.parse(localStorage.getItem("sa-known") || "[]")),
  pre: new Map(), post: new Map(),          // concept id -> prerequisite ids / dependents
};
let nodes = [], links = [], byId = new Map();

const svg = d3.select("#tree");
svg.append("defs").append("marker").attr("id", "arrow").attr("viewBox", "0 -4 8 8")
  .attr("refX", 8).attr("refY", 0).attr("markerWidth", 7).attr("markerHeight", 7)
  .attr("orient", "auto").append("path").attr("d", "M0,-4L8,0L0,4").attr("class", "arrow-head");
const root = svg.append("g");
const linkLayer = root.append("g");
const nodeLayer = root.append("g");
const zoomer = d3.zoom().scaleExtent([0.15, 4]).on("zoom", (ev) => root.attr("transform", ev.transform));
svg.call(zoomer).on("dblclick.zoom", null);

const sim = d3.forceSimulation()
  .force("charge", d3.forceManyBody().strength(-90))
  .force("link", d3.forceLink().id((d) => d.id)
    .distance((l) => (l.type === "beyond" ? 120 : 200))
    .strength((l) => (l.type === "beyond" ? 0.15 : 0.01)))
  .force("x", d3.forceX((d) => d.tx).strength((d) => (d.type === "concept" ? 0.8 : 0.3)))
  .force("y", d3.forceY((d) => d.ty).strength((d) => (d.type === "concept" ? 0.25 : 0.08)))
  .force("collide", rectCollide())
  .on("tick", ticked);

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

const deckColor = (i) => { const h = HUES[isDark() ? "dark" : "light"]; return h[i % h.length]; };
const COURSES = { intro_ml: "Introduction to Machine Learning", ml4science: "Machine Learning for Science",
                  other: "Other lessons" };
// a concept's colour: its deck's hue when there are few decks; with many, its
// course's hue, lighter early in the course and darker late
function nodeColor(n) {
  if (!S.many) return deckColor(n.row);
  const base = d3.hsl(deckColor(S.courses.indexOf(n.course)));
  base.l = (isDark() ? 0.68 : 0.62) - 0.3 * n.progress;
  return base.formatHex();
}

// ------------------------------------------------------------------ data

async function load() {
  const g = await fetch("/learn/graph.json").then((r) => r.json());
  S.graph = g;
  const concepts = g.nodes.filter((n) => n.type === "concept");
  // two keys can share one article ("Exponential family"); name those by key
  const wikiCount = {};
  concepts.forEach((n) => { if (n.wiki) wikiCount[n.wiki] = (wikiCount[n.wiki] || 0) + 1; });
  concepts.forEach((n) => {
    n.label = (n.wiki && wikiCount[n.wiki] === 1) ? n.name : n.key.replace(/-/g, " ");
    n.label = n.label.charAt(0).toUpperCase() + n.label.slice(1);
  });
  g.edges.filter((e) => e.type === "prereq").forEach((e) => {
    if (!S.pre.has(e.target)) S.pre.set(e.target, []);
    if (!S.post.has(e.source)) S.post.set(e.source, []);
    S.pre.get(e.target).push(e.source);
    S.post.get(e.source).push(e.target);
  });
  // depth = longest chain of prerequisites below a concept
  const depth = new Map();
  const dfs = (id, stack = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const ps = S.pre.get(id) || [];
    const d = ps.length ? 1 + Math.max(...ps.map((p) => dfs(p, stack))) : 0;
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  concepts.forEach((n) => dfs(n.id));
  const deckOrder = g.course_order.filter((d) => concepts.some((n) => n.lesson.deck === d));
  S.decks = deckOrder.map((d) => ({ id: d, title: (g.deck_titles || {})[d] || d,
    course: concepts.find((n) => n.lesson.deck === d).course }));
  // with many decks (both courses tagged), rows are courses, not decks
  S.many = S.decks.length > 10;
  S.courses = [...new Set(S.decks.map((d) => d.course))];
  const inCourse = (n) => S.decks.filter((d) => d.course === n.course);
  concepts.forEach((n) => {
    const ds = inCourse(n);
    n.progress = ds.length > 1 ? ds.findIndex((d) => d.id === n.lesson.deck) / (ds.length - 1) : 0;
  });
  concepts.forEach((n) => {
    n.depth = depth.get(n.id);
    n.row = deckOrder.indexOf(n.lesson.deck);
    n.tx = n.depth * COL;
    n.ty = S.many ? S.courses.indexOf(n.course) * 900 + (n.progress - 0.5) * 520 : n.row * ROW;
  });
  S.concepts = concepts;
  S.beyond = g.nodes.filter((n) => n.type === "beyond");
  const near = {};
  g.edges.filter((e) => e.type === "beyond").forEach((e) => (near[e.source] ||= []).push(e.target));
  S.beyond.forEach((b) => { b.near = near[b.id] || []; });

  const c = (t) => g.edges.filter((e) => e.type === t).length;
  $("stats").textContent = `${concepts.length} concepts in ${S.decks.length} decks` +
    (S.many ? ` across ${S.courses.length} courses · ` : " · ") +
    `${c("prereq")} prerequisite links (arrows) · ${c("wiki")} Wikipedia links · ` +
    `${S.beyond.length} articles just beyond · built ${g.built}`;
  $("method").textContent = `Prerequisites come from the course's slide tags; articles beyond ` +
    `from ${g.sources.frontier_model || "a small model"} reading each concept's Wikipedia article. ` +
    `Data: /learn/graph.json.`;
  legend();
  build(+$("beyondN").value);
  renderList();
  renderPlan();
  const m = location.hash.match(/c=([\w-]+)/);
  if (m) setTimeout(() => { const n = byId.get("c:" + m[1]); if (n) { zoomTo(n); showCard(n); } }, 1700);
}

function build(nBeyond) {
  const old = new Map(nodes.map((n) => [n.id, n]));
  const shown = S.beyond.slice(0, nBeyond);
  const cById = new Map(S.concepts.map((n) => [n.id, n]));
  shown.forEach((b) => {
    const ns = b.near.map((id) => cById.get(id)).filter(Boolean);
    if (!ns.length) { b.tx = 0; b.ty = 0; return; }
    const d = b.role === "basis" ? Math.min(...ns.map((n) => n.depth)) - 0.55
                                 : Math.max(...ns.map((n) => n.depth)) + 0.55;
    b.tx = d * COL;
    b.ty = ns.reduce((s, n) => s + n.ty, 0) / ns.length;
  });
  nodes = [...S.concepts, ...shown].map((n) => {
    const o = old.get(n.id);
    return Object.assign(n, o ? { x: o.x, y: o.y } :
      { x: n.tx + (Math.random() - 0.5) * 60, y: n.ty + (Math.random() - 0.5) * 80 });
  });
  byId = new Map(nodes.map((n) => [n.id, n]));
  links = S.graph.edges
    .filter((e) => byId.has(e.source) && byId.has(e.target) &&
      (e.type === "prereq" || e.type === "wiki" || e.type === "beyond" || e.type === "preview"))
    .map((e) => ({ ...e }));
  draw();
  sim.nodes(nodes);
  sim.force("link").links(links);
  sim.force("collide").initialize(nodes);
  sim.alpha(1).restart();
  setTimeout(fit, 1800);
}

// ------------------------------------------------------------------ drawing

const label = (d) => (d.type === "concept" ? d.label : d.article.replace(/ \(.*\)$/, ""));

function draw() {
  linkLayer.selectAll("line")
    .data(links, (l) => `${l.source.id || l.source}|${l.target.id || l.target}|${l.type}`)
    .join("line")
    .attr("class", (l) => "t-link " + l.type)
    .attr("marker-end", (l) => (l.type === "prereq" ? "url(#arrow)" : null));

  nodeLayer.selectAll("g.t-node")
    .data(nodes, (d) => d.id)
    .join((enter) => {
      const e = enter.append("g").attr("class", (d) => "t-node " + d.type);
      e.append("rect").attr("rx", 5);
      e.append("text").attr("text-anchor", "middle").attr("dy", "0.35em").text(label);
      e.on("mouseenter", (ev, d) => { trace(d); showTip(ev, tip(d)); })
        .on("mousemove", moveTip)
        .on("mouseleave", () => { trace(null); hideTip(); })
        .on("click", (ev, d) => {
          if (S.plan && d.type === "concept") return toggleKnown(d);
          showCard(d);
        })
        .call(d3.drag()
          .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.1).restart(); d.fx = d.x; d.fy = d.y; })
          .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
          .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
      return e;
    });
  restyle();
}

function status(d) {
  if (d.type !== "concept") return null;
  if (S.known.has(d.id)) return "known";
  return (S.pre.get(d.id) || []).every((p) => S.known.has(p)) ? "ready" : "locked";
}

function restyle() {
  const g = nodeLayer.selectAll("g.t-node");
  g.classed("named", (d) => d.type === "beyond" && d.named_in.length > 0)
    .classed("known", (d) => S.plan && status(d) === "known")
    .classed("ready", (d) => S.plan && status(d) === "ready")
    .classed("locked", (d) => S.plan && status(d) === "locked")
    .classed("reach", (d) => S.plan && d.type === "beyond" && inReach(d));
  g.select("text")
    .style("font-size", (d) => (d.type === "concept" ? 15 : 12) + "px")
    .style("fill", (d) => {
      if (d.type !== "concept") return css("--ink-dim");
      return d3.lab(nodeColor(d)).l > 60 ? "#12151b" : "#f4f6f9";
    });
  g.each(function (d) {
    const b = d3.select(this).select("text").node().getBBox();
    d.w = b.width + 14; d.h = b.height + 8;
  });
  g.select("rect")
    .attr("x", (d) => -d.w / 2).attr("y", (d) => -d.h / 2)
    .attr("width", (d) => d.w).attr("height", (d) => d.h)
    .style("fill", (d) => (d.type === "concept" ? nodeColor(d) : css("--bg")))
    .style("stroke", (d) => (d.type === "concept" ? null : css("--ink-dim")));
}

function ticked() {
  linkLayer.selectAll("line").each(function (l) {
    // stop arrows at the edge of the target box
    const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y;
    const len = Math.hypot(dx, dy) || 1;
    const tw = (l.target.w || 40) / 2, th = (l.target.h || 20) / 2;
    const cut = Math.min(Math.abs(dx) > 1e-6 ? tw / Math.abs(dx / len) : Infinity,
                         Math.abs(dy) > 1e-6 ? th / Math.abs(dy / len) : Infinity) + 3;
    d3.select(this)
      .attr("x1", l.source.x).attr("y1", l.source.y)
      .attr("x2", l.target.x - (dx / len) * (l.type === "prereq" ? cut : 0))
      .attr("y2", l.target.y - (dy / len) * (l.type === "prereq" ? cut : 0));
  });
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

// Trace back to the basics and forward to where it leads.
function closure(id, map) {
  const out = new Set(), stack = [id];
  while (stack.length) {
    for (const n of map.get(stack.pop()) || []) if (!out.has(n)) { out.add(n); stack.push(n); }
  }
  return out;
}

function trace(d) {
  const g = nodeLayer.selectAll("g.t-node");
  if (!d) {
    g.classed("dim", false).classed("hot", false).classed("anc", false).classed("desc", false);
    linkLayer.selectAll("line").classed("dim", false).classed("hot", false);
    return;
  }
  const anc = d.type === "concept" ? closure(d.id, S.pre) : new Set();
  const desc = d.type === "concept" ? closure(d.id, S.post) : new Set();
  const near = new Set([d.id, ...anc, ...desc]);
  links.forEach((l) => {
    if (l.type === "beyond" && (l.source.id === d.id || l.target.id === d.id)) {
      near.add(l.source.id); near.add(l.target.id);
    }
  });
  g.classed("dim", (n) => !near.has(n.id)).classed("hot", (n) => n.id === d.id)
    .classed("anc", (n) => anc.has(n.id)).classed("desc", (n) => desc.has(n.id));
  linkLayer.selectAll("line")
    .classed("hot", (l) => near.has(l.source.id) && near.has(l.target.id) && l.type !== "wiki")
    .classed("dim", (l) => !(near.has(l.source.id) && near.has(l.target.id)));
}

function zoomTo(d) {
  const el = svg.node(), k = 1.1;
  svg.transition().duration(500).call(zoomer.transform,
    d3.zoomIdentity.translate(el.clientWidth / 2 - k * d.x, el.clientHeight / 2 - k * d.y).scale(k));
  trace(d);
  setTimeout(() => trace(null), 2600);
}

function legend() {
  if (S.many) {
    $("legend").innerHTML = S.courses.map((c, i) =>
      `<span><i style="background:linear-gradient(90deg, ${nodeColor({ course: c, progress: 0 })}, ` +
      `${nodeColor({ course: c, progress: 1 })})"></i>${esc(COURSES[c] || c)} (lighter = earlier)</span>`).join("") +
      `<span><i class="arrow-key"></i>needed first</span><span><i class="dot-key"></i>glimpsed earlier</span>` +
      `<span><i class="dash"></i>beyond the course</span>`;
    return;
  }
  $("legend").innerHTML = S.decks.map((d, i) =>
    `<span data-deck="${esc(d.id)}" title="${S.plan ? "Mark this part as known" : ""}">` +
    `<i style="background:${deckColor(i)}"></i>${esc(d.title)}</span>`).join("") +
    `<span><i class="arrow-key"></i>needed first</span><span><i class="dash"></i>beyond the course</span>`;
  $("legend").querySelectorAll("[data-deck]").forEach((s) => s.addEventListener("click", () => {
    if (!S.plan) return;
    S.concepts.filter((n) => n.lesson.deck === s.dataset.deck).forEach((n) => S.known.add(n.id));
    saveKnown();
  }));
}

// ------------------------------------------------------------------ details

const names = (ids) => ids.map((id) => byId.get(id)).filter(Boolean).map(label);

function tip(d) {
  if (d.type === "concept") {
    const ps = names(S.pre.get(d.id) || []), ls = names(S.post.get(d.id) || []);
    return `<b>${esc(d.label)}</b><i>${esc(d.lesson.title)}</i> · ${esc(d.lesson.deck_title)}<br>` +
      (ps.length ? `Needs ${esc(ps.join(", "))}<br>` : "Needs nothing earlier in the course<br>") +
      (ls.length ? `Leads to ${esc(ls.join(", "))}<br>` : "") +
      (S.plan ? `Click to mark as ${S.known.has(d.id) ? "not " : ""}known.` : "Click for the lesson and the map.");
  }
  return `<b>${esc(d.article)}</b>${d.about ? `<i>${esc(d.about)}</i><br>` : ""}` +
    `${d.role === "basis" ? "A foundation" : "A next step"} for ${esc(names(d.near).join(", "))}` +
    (d.named_in.length ? `<br>Named in the lesson title "${esc(d.named_in[0])}": possibly taught, not tagged.` : "") +
    "<br>Click for more.";
}

function showCard(d) {
  let html;
  if (d.type === "concept") {
    const ps = (S.pre.get(d.id) || []).map((id) => byId.get(id)).filter(Boolean);
    const ls = (S.post.get(d.id) || []).map((id) => byId.get(id)).filter(Boolean);
    const link = (n) => `<a href="#" data-id="${esc(n.id)}">${esc(label(n))}</a>`;
    html = `<span class="card-kicker">Taught in ${esc(d.lesson.deck_title)}</span>
      <h3>${esc(d.label)}</h3>
      <p class="card-about">${esc(d.lesson.title)}</p>
      <p>${ps.length ? `Needs ${ps.map(link).join(", ")}.` : "Needs nothing earlier in the course."}
         ${ls.length ? `Leads to ${ls.map(link).join(", ")}.` : ""}</p>
      ${d.definition ? `<p class="card-def">${esc(d.definition)}</p>` : ""}
      ${(d.previewed_in || []).length ? `<p class="card-about">First glimpsed in ${esc(d.previewed_in.join(", "))},
        before it is taught.</p>` : ""}
      <div class="card-actions">
        <a class="primary" href="${esc(d.lesson.url)}" target="_blank" rel="noopener">Open the lesson</a>
        <a href="/q?concept=${encodeURIComponent(d.key)}" target="_blank" rel="noopener">Where it comes from, on the map</a>
      </div>`;
  } else {
    const q = `What is ${d.article.replace(/ \(.*\)$/, "")}, and how does it connect to ${names(d.near)[0] || ""}?`;
    html = `<span class="card-kicker">${d.role === "basis" ? "A foundation the course rests on" : "Where the course leads"}</span>
      <h3>${esc(d.article)}</h3>
      ${d.about ? `<p class="card-about">${esc(d.about)}</p>` : ""}
      <p>Next to ${d.near.map((id) => byId.get(id)).filter(Boolean)
        .map((n) => `<a href="#" data-id="${esc(n.id)}">${esc(label(n))}</a>`).join(", ")} in the course.</p>
      ${d.named_in.length ? `<p class="card-named">Its name appears in the lesson title "${esc(d.named_in[0])}",
        so it may already be taught without a concept tag.</p>` : ""}
      <div class="card-actions">
        <a class="primary" href="/q?q=${encodeURIComponent(q)}" target="_blank" rel="noopener">Explore it on the map</a>
        <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(d.article.replace(/ /g, "_"))}"
           target="_blank" rel="noopener">Wikipedia</a>
      </div>`;
  }
  $("card").innerHTML = `<button class="modal-x" type="button" aria-label="Close">×</button>` + html;
  $("card").hidden = false;
  $("card").querySelector(".modal-x").addEventListener("click", () => { $("card").hidden = true; });
  $("card").querySelectorAll("[data-id]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const n = byId.get(a.dataset.id);
    if (n) { zoomTo(n); showCard(n); }
  }));
}

function renderList() {
  const f = S.filter;
  const items = S.beyond.filter((x) =>
    f === "all" || (f === "named" ? x.named_in.length : x.role === f)).slice(0, 100);
  $("beyondList").innerHTML = items.map((x) => `
    <li data-id="${esc(x.id)}">
      <span class="b-name">${esc(x.article)}</span>
      <span class="b-score">${x.score.toFixed(1)}</span>
      <span class="b-near">${x.role === "basis" ? "foundation for" : "next after"}
        ${esc(x.near.map((id) => S.concepts.find((c) => c.id === id)?.label || id).slice(0, 3).join(", "))}</span>
    </li>`).join("");
  $("beyondList").querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
    const go = () => { const n = byId.get(li.dataset.id); if (n) { zoomTo(n); showCard(n); } };
    if (byId.has(li.dataset.id)) go();
    else { $("beyondN").value = "160"; build(160); setTimeout(go, 1900); }
  }));
}

// ------------------------------------------------------------------ plan my path

function inReach(b) {
  return b.near.length > 0 && b.near.every((id) => S.known.has(id));
}

function saveKnown() {
  try { localStorage.setItem("sa-known", JSON.stringify([...S.known])); } catch (e) {}
  restyle();
  renderPlan();
}

function toggleKnown(d) {
  if (S.known.has(d.id)) S.known.delete(d.id); else S.known.add(d.id);
  saveKnown();
}

function renderUpTo() {
  const sel = $("upTo");
  if (!sel || sel.options.length > 1) return;
  S.decks.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = (S.many ? (COURSES[d.course] || d.course).split(" ").slice(-2).join(" ") + ": " : "") + d.title;
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    const upto = +sel.value;
    if (Number.isNaN(upto)) return;
    const target = S.decks[upto];
    // everything taught in that course up to and including that deck
    S.decks.slice(0, upto + 1).filter((d) => !S.many || d.course === target.course).forEach((d) =>
      S.concepts.filter((n) => n.lesson.deck === d.id).forEach((n) => S.known.add(n.id)));
    sel.value = "";
    saveKnown();
  });
}

function renderPlan() {
  renderUpTo();
  const ready = S.concepts.filter((n) => status(n) === "ready")
    .sort((a, b) => a.depth - b.depth || a.row - b.row);
  $("planStats").textContent = `${S.known.size} of ${S.concepts.length} concepts known · ` +
    `${ready.length} ready to learn next`;
  $("readyList").innerHTML = ready.slice(0, 30).map((n) => `
    <li data-id="${esc(n.id)}"><span class="b-name">${esc(n.label)}</span>
      <a class="b-score" href="${esc(n.lesson.url)}" target="_blank" rel="noopener">lesson</a>
      <span class="b-near">${esc(n.lesson.deck_title)}</span></li>`).join("");
  const reach = S.beyond.filter(inReach).slice(0, 20);
  $("reachList").innerHTML = reach.length ? reach.map((b) => `
    <li data-id="${esc(b.id)}"><span class="b-name">${esc(b.article)}</span>
      <span class="b-score">${b.role === "basis" ? "foundation" : "next"}</span></li>`).join("")
    : `<li class="empty">Mark a few concepts as known to see what opens up beyond the course.</li>`;
  [$("readyList"), $("reachList")].forEach((ol) => ol.querySelectorAll("li[data-id]").forEach((li) =>
    li.addEventListener("click", (e) => {
      if (e.target.tagName === "A") return;
      const n = byId.get(li.dataset.id);
      if (n) { zoomTo(n); showCard(n); }
    })));
}

function setPlan(on) {
  S.plan = on;
  document.body.classList.toggle("planning", on);
  $("planBtn").textContent = on ? "Done planning" : "Plan my path";
  $("planSide").hidden = !on;
  $("beyondSide").hidden = on;
  $("card").hidden = true;
  legend(); restyle(); renderPlan();
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
$("introX").addEventListener("click", () => { $("intro").hidden = true; });
addEventListener("hashchange", () => {
  const m = location.hash.match(/c=([\w-]+)/);
  const n = m && byId.get("c:" + m[1]);
  if (n) { zoomTo(n); showCard(n); }
});
$("planBtn").addEventListener("click", () => setPlan(!S.plan));
$("clearKnown").addEventListener("click", () => { S.known.clear(); saveKnown(); });
$("beyondN").addEventListener("change", (e) => build(+e.target.value));
$("tabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
  $("tabs").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  S.filter = b.dataset.f;
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
