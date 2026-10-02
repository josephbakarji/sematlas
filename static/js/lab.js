/**
 * SemAtlas Lab: both courses as one map of ideas, and what lies beyond them.
 *
 * The map's design is the concept map in sematlas-learn (lab/concept-graph):
 * layouts are computed once, offline (scripts/bake_lab_layout.py opens this
 * page with ?bake=1 and saves window.__layout to data/lab_layout.json), so the
 * page never runs a simulation; it draws stored positions and glides between
 * three layouts. Concepts are pills tinted by course, every one labelled.
 * Zooming out, labels grow on screen up to GROW times their size, then shrink
 * with the map; layouts are spaced for the largest size, so no two labels
 * overlap at any zoom. Zooming writes one CSS variable, nothing per node. Hover traces a concept back to its basics (gold) and
 * forward to what it unlocks (teal), by toggling one class on the lit chain.
 *
 * SemAtlas adds three layers on the same data (/learn/graph.json): the
 * Wikipedia articles just beyond the courses, a "plan my path" mode, and links
 * from every concept to its lesson, its place on the question map and its
 * Wikipedia article. #c=<concept key> opens on a concept.
 */
(async function () {
  const BAKE = /bake/.test(location.search);
  const BEYOND_N = 200;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const isDark = () => document.documentElement.getAttribute("data-theme") !== "light";

  const G = await (await fetch("/learn/graph.json")).json();
  let L = null;
  if (!BAKE) try { const r = await fetch("/learn/lab_layout.json", { cache: "no-store" }); if (r.ok) L = await r.json(); } catch (e) { L = null; }

  const svg = d3.select("#map"), root = svg.append("g");
  let W = innerWidth, H = innerHeight;

  // ---------------------------------------------------------------- data
  const cnodes = G.nodes.filter((n) => n.type === "concept");
  const keyOf = (id) => id.replace(/^c:/, "");
  const N = cnodes.map((n) => ({
    id: n.key, name: n.name || n.key.replace(/-/g, " "), deck: n.lesson.deck, url: n.lesson.url,
    lesson: n.lesson.title, deckTitle: n.lesson.deck_title, definition: n.definition, wiki: n.wiki,
    closest: n.wiki_closest, course: n.course || "intro_ml", previewed: n.previewed_in || [],
  }));
  const byId = new Map(N.map((d) => [d.id, d]));
  const deckIds = (G.course_order || []).filter((d) => N.some((n) => n.deck === d));
  const decks = deckIds.map((id, i) => ({
    id, i, title: (G.deck_titles || {})[id] || id, course: N.find((n) => n.deck === id).course,
  }));
  const di = Object.fromEntries(decks.map((d) => [d.id, d.i]));
  const inCourse = {};
  decks.forEach((d) => { (inCourse[d.course] = inCourse[d.course] || []).push(d.id); });
  const col = (id) => {
    const d = decks[di[id]], list = inCourse[d.course];
    const t = list.length > 1 ? list.indexOf(id) / (list.length - 1) : 0;
    return d3.hsl(d.course === "intro_ml" ? 200 + 120 * t : 20 + 140 * t,
                  isDark() ? 0.62 : 0.55, isDark() ? 0.64 : 0.42).formatHex();
  };
  const E = G.edges.filter((e) => e.type === "prereq" && byId.has(keyOf(e.source)) && byId.has(keyOf(e.target)))
    .map((e) => ({ source: byId.get(keyOf(e.source)), target: byId.get(keyOf(e.target)) }));
  const PE = G.edges.filter((e) => e.type === "preview" && byId.has(keyOf(e.source)) && byId.has(keyOf(e.target)))
    .map((e) => ({ source: byId.get(keyOf(e.source)), target: byId.get(keyOf(e.target)), preview: true }));
  N.forEach((d) => { d.pre = []; d.post = []; });
  E.forEach((e) => { e.target.pre.push(e.source); e.source.post.push(e.target); e.back = di[e.source.deck] > di[e.target.deck]; });
  N.forEach((d) => { d.deg = d.pre.length + d.post.length; });
  const depth = (d) => d._depth ?? (d._depth = d.pre.length ? 1 + d3.max(d.pre, depth) : 0);
  N.forEach(depth);

  // story decks: questions, linked to the concepts they teach
  const Q = G.nodes.filter((n) => n.type === "deck").map((n) => ({
    id: n.id, q: true, question: n.question, url: n.url,
    teaches: G.edges.filter((e) => e.source === n.id && e.type === "teaches").map((e) => keyOf(e.target)),
  }));
  const QE = Q.flatMap((q) => q.teaches.map((k) => ({ source: q, target: byId.get(k) })).filter((e) => e.target));

  // beyond the course: Wikipedia articles next to taught concepts
  const near = {};
  G.edges.filter((e) => e.type === "beyond").forEach((e) => (near[e.source] ||= []).push(keyOf(e.target)));
  const B = G.nodes.filter((n) => n.type === "beyond").slice(0, BEYOND_N).map((n) => ({
    id: n.id, beyond: true, name: n.article.replace(/ \(.*\)$/, ""), article: n.article, about: n.about,
    role: n.role, score: n.score, named: n.named_in || [], near: (near[n.id] || []).filter((k) => byId.has(k)),
  })).filter((b) => b.near.length);
  const BE = B.flatMap((b) => b.near.map((k) => ({ source: b, target: byId.get(k) })));
  const ALL = N.concat(Q, B);
  const ranked = N.slice().sort((a, b) => b.deg - a.deg);
  ranked.forEach((d, i) => { d.rank = i; });
  B.forEach((b, i) => { b.rank = N.length + i; });

  // ---------------------------------------------------------------- drawing
  const hullG = root.append("g"), edgeG = root.append("g"), beG = root.append("g"), qeG = root.append("g"),
        axisG = root.append("g").attr("class", "axis"), nodeG = root.append("g"), qG = root.append("g");
  const markers = () => svg.selectAll("defs").data([0]).join("defs").selectAll("marker")
    .data(["link", "back", "up", "down"]).join("marker").attr("id", (d) => "m-" + d)
    .attr("viewBox", "0 -4 8 8").attr("refX", 8).attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
    .selectAll("path").data((d) => [d]).join("path").attr("d", "M0,-4L8,0L0,4")
    .attr("fill", (d) => css({ link: "--link", back: "--back", up: "--accent", down: "--learn" }[d]));
  markers();
  const tint = (c) => d3.interpolateRgb(css("--bg"), c)(isDark() ? 0.24 : 0.16);
  const node = nodeG.selectAll("g").data(N.concat(B)).join("g")
    .attr("class", (d) => "node" + (d.beyond ? " beyond" : d.deg >= 6 ? " big" : ""));
  const lbl = node.append("g").attr("class", "lbl");
  lbl.append("rect");
  lbl.append("text").attr("text-anchor", "middle").text((d) => d.name);
  node.each(function (d) {
    d.w = this.querySelector("text").getComputedTextLength() + 18;
    d.h = d.beyond ? 20 : d.deg >= 6 ? 26 : 22;
  });
  const paint = () => node.filter((d) => !d.beyond).select("rect")
    .attr("fill", (d) => tint(col(d.deck))).attr("stroke", (d) => col(d.deck));
  paint();
  const qn = qG.selectAll("g").data(Q).join("g").attr("class", "q")
    .on("click", (e, d) => open(d.url, "_blank", "noopener"));
  const qlbl = qn.append("g").attr("class", "lbl");   // story decks scale with the labels too
  qlbl.append("rect");
  qlbl.append("text").attr("text-anchor", "middle").text((d) => "★  " + d.question);
  qn.each(function (d) { d.w = this.querySelector("text").getComputedTextLength() + 26; d.h = 30; });
  qlbl.select("rect").attr("x", (d) => -d.w / 2).attr("y", (d) => -d.h / 2)
    .attr("width", (d) => d.w).attr("height", (d) => d.h).attr("rx", 8);

  // ---------------------------------------------------------------- layouts (baked offline)
  function rectCollide(pad, vertical) {
    let nodes;
    const force = () => {
      for (let pass = 0; pass < 2; pass++) {
        const qt = d3.quadtree(nodes, (d) => d.x, (d) => d.y), mw = d3.max(nodes, (d) => d.w), mh = d3.max(nodes, (d) => d.h);
        for (const a of nodes) qt.visit((q, x0, y0, x1, y1) => {
          const b = q.data;
          if (b && b !== a) {
            const dx = b.x - a.x, dy = b.y - a.y, ox = (a.w + b.w) / 2 + pad - Math.abs(dx), oy = (a.h + b.h) / 2 + pad - Math.abs(dy);
            if (ox > 0 && oy > 0) {
              if (!vertical && ox / (a.w + b.w) < oy / (a.h + b.h)) { const m = (dx < 0 ? -1 : 1) * ox / 2; a.x -= m; b.x += m; }
              else { const m = (dy < 0 ? -1 : 1) * (oy / 2 + 0.01); a.y -= m; b.y += m; }
            }
          }
          return x0 > a.x + (a.w + mw) / 2 + pad || x1 < a.x - (a.w + mw) / 2 - pad ||
                 y0 > a.y + (a.h + mh) / 2 + pad || y1 < a.y - (a.h + mh) / 2 - pad;
        });
      }
    };
    force.initialize = (ns) => { nodes = ns; };
    return force;
  }
  const GROW = 1.9, SPAN = Math.sqrt(N.length) * 160, GAP = 10;
  const COLW = Math.round(GROW * d3.quantile(N.map((d) => d.w).sort(d3.ascending), 0.9) + 60);
  const overlaps = (ns) => {
    let c = 0;
    const qt = d3.quadtree(ns, (d) => d.x, (d) => d.y), mw = d3.max(ns, (d) => d.w), mh = d3.max(ns, (d) => d.h);
    for (const a of ns) qt.visit((q, x0, y0, x1, y1) => {
      const b = q.data;
      if (b && a.id < b.id && Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + 2) c++;
      return x0 > a.x + (a.w + mw) / 2 || x1 < a.x - (a.w + mw) / 2 || y0 > a.y + (a.h + mh) / 2 || y1 < a.y - (a.h + mh) / 2;
    });
    return c;
  };
  const mean = (xs) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  // depth rings: each band's area is sized to hold its labels at their largest
  const ringOf = (d) => d.beyond
    ? (d.role === "basis" ? Math.max(0, d3.min(d.near, (k) => byId.get(k)._depth) - 0.5)
                          : d3.max(d.near, (k) => byId.get(k)._depth) + 0.6)
    : d._depth;
  const RING = (() => {
    const need = [];
    N.concat(B).forEach((d) => { const j = Math.max(0, Math.round(ringOf(d))); need[j] = (need[j] || 0) + (GROW * d.w + GAP) * (GROW * d.h + GAP); });
    let r = 120; const mid = [];
    for (let j = 0; j < need.length; j++) {
      const r2 = Math.sqrt(r * r + 1.6 * (need[j] || 0) / Math.PI);
      mid.push(Math.sqrt((r * r + r2 * r2) / 2)); r = Math.max(r2, r + 60);
    }
    const at = (x) => { const i = Math.floor(x), f = x - i; return i + 1 >= mid.length ? mid[mid.length - 1] : mid[i] + (mid[i + 1] - mid[i]) * f; };
    return { mid, at, outer: r };
  })();
  // layouts are made for labels at their largest, GROW times their size
  function compute(mode) {
    ALL.forEach((d) => { d.w0 = d.w; d.h0 = d.h; d.w *= GROW; d.h *= GROW; });
    try { return layoutFor(mode); } finally { ALL.forEach((d) => { d.w = d.w0; d.h = d.h0; }); }
  }
  function layoutFor(mode) {
    if (mode === "web") {   // first the lectures, as a graph weighted by the links between them
      const w = {};
      E.forEach((e) => { const a = e.source.deck, b = e.target.deck; if (a !== b) { const k = a < b ? a + "|" + b : b + "|" + a; w[k] = (w[k] || 0) + 1; } });
      const DN = decks.map((d) => ({ id: d.id, n: N.filter((x) => x.deck === d.id).length,
        x: (d.course === "intro_ml" ? -1 : 1) * SPAN * 0.4 + (Math.random() - 0.5) * 50, y: (Math.random() - 0.5) * SPAN * 0.4 }));
      const dm = new Map(DN.map((d) => [d.id, d]));
      const DL = Object.entries(w).map(([k, v]) => ({ source: dm.get(k.split("|")[0]), target: dm.get(k.split("|")[1]), w: v }));
      d3.forceSimulation(DN).stop().force("link", d3.forceLink(DL).distance((d) => 760 / Math.sqrt(d.w)).strength((d) => Math.min(1, d.w / 12)))
        .force("charge", d3.forceManyBody().strength((d) => -4000 - 600 * d.n)).force("collide", d3.forceCollide((d) => 120 + 46 * Math.sqrt(d.n)))
        .force("x", d3.forceX(0).strength(0.06)).force("y", d3.forceY(0).strength(0.08)).tick(600);
      const centre = (d) => d.q ? { x: 0, y: -SPAN * 0.6 } : d.beyond
        ? { x: mean(d.near.map((k) => dm.get(byId.get(k).deck).x)), y: mean(d.near.map((k) => dm.get(byId.get(k).deck).y)) }
        : dm.get(d.deck);
      ALL.forEach((d) => { const c = centre(d); d.x = c.x + (Math.random() - 0.5) * 160; d.y = c.y + (Math.random() - 0.5) * 160; });
      d3.forceSimulation(ALL).stop()
        .force("link", d3.forceLink(E.concat(QE, BE)).distance((l) => l.source.beyond ? 160 : 130).strength((l) => l.source.beyond ? 0.06 : 0.015))
        .force("charge", d3.forceManyBody().strength(-110).distanceMax(700))
        .force("x", d3.forceX((d) => centre(d).x).strength((d) => d.beyond ? 0.03 : 0.07))
        .force("y", d3.forceY((d) => centre(d).y).strength((d) => d.beyond ? 0.03 : 0.07))
        .force("collide", rectCollide(GAP, false)).tick(600);
    } else if (mode === "time") {   // a column per lecture, in course order
      const x = d3.scalePoint().domain(decks.map((d) => d.id)).range([0, decks.length * COLW]);
      const tx = (d) => d.q ? x.range()[1] / 2 : d.beyond ? mean(d.near.map((k) => x(byId.get(k).deck))) + 60 : x(d.deck);
      ALL.forEach((d) => { d.x = tx(d); d.y = (Math.random() - 0.5) * 600; });
      d3.forceSimulation(ALL).stop().force("link", d3.forceLink(E.concat(QE)).strength(0.01))
        .force("x", d3.forceX(tx).strength((d) => d.beyond ? 0.6 : 1.5)).force("y", d3.forceY((d) => d.q ? -420 : 0).strength(0.04))
        .force("collide", rectCollide(GAP, true)).tick(500);
    } else {   // rings of prerequisite depth, each lecture in its own sector
      const ang = d3.scaleLinear().domain([0, decks.length]).range([0, 2 * Math.PI]);
      const rr = (d) => d.q ? RING.outer + 160 : RING.at(ringOf(d));
      const angle = (d) => d.q ? -Math.PI / 2 : d.beyond ? mean(d.near.map((k) => ang(di[byId.get(k).deck] + 0.5))) : ang(di[d.deck] + 0.5);
      ALL.forEach((d) => { const a = angle(d); d.x = Math.cos(a) * rr(d); d.y = Math.sin(a) * rr(d); });
      d3.forceSimulation(ALL).stop().force("r", d3.forceRadial(rr, 0, 0).strength(0.35)).force("collide", rectCollide(GAP, false)).tick(500);
    }
    // then only the collision, until no two labels touch at the layout's own scale
    const sep = rectCollide(GAP, false); sep.initialize(ALL);
    for (let i = 0; i < 400 && overlaps(ALL) > 0; i++) sep();
    return Object.fromEntries(ALL.map((d) => [d.id, [Math.round(d.x), Math.round(d.y)]]));
  }
  if (BAKE) {
    const out = { built: new Date().toISOString() }, left = {};
    for (const m of ["web", "time", "depth"]) {
      out[m] = compute(m);
      ALL.forEach((d) => { d.w *= GROW; d.h *= GROW; }); left[m] = overlaps(ALL); ALL.forEach((d) => { d.w /= GROW; d.h /= GROW; });
    }
    out.overlaps = left;
    window.__layout = out;
    return;
  }
  if (!L || !L.web || N.some((d) => !L.web[d.id])) {   // nothing baked for this graph yet
    L = { web: compute("web"), time: compute("time"), depth: compute("depth") };
  }

  // ---------------------------------------------------------------- geometry
  let mode = "web", pinned = null, lit = new Set(), hullDeck = null;
  let showBeyond = false, planning = false, moving = false;
  const off = new Set();
  const KNOWN = "sa-known";
  let known = new Set();
  try { known = new Set(JSON.parse(localStorage.getItem(KNOWN) || "[]").map(keyOf)); } catch (e) {}

  const edge = edgeG.selectAll("path").data(E.concat(PE)).join("path")
    .attr("class", (e) => "edge" + (e.preview ? " preview" : e.back ? " back" : ""));
  const qedge = qeG.selectAll("path").data(QE).join("path").attr("class", "qedge");
  const bedge = beG.selectAll("path").data(BE).join("path").attr("class", "bedge");
  const visible = (d) => !d.beyond || showBeyond;
  let S = 1;   // the labels' scale: 1 zoomed in, up to GROW zoomed out
  const box = (d) => [d.w * S, d.h * S];
  const edgeOf = (t, dx, dy) => {
    const [w, h] = box(t), s = Math.min((w / 2 + 3) / Math.abs(dx || 1e-9), (h / 2 + 3) / Math.abs(dy || 1e-9));
    return [t.x - dx * s, t.y - dy * s];
  };
  const arc = (e) => {
    const s = e.source, t = e.target, dx = t.x - s.x, dy = t.y - s.y, [tx, ty] = edgeOf(t, dx, dy), b = mode === "time" ? 0.2 : 0.08;
    return `M${s.x},${s.y}Q${(s.x + tx) / 2 - dy * b},${(s.y + ty) / 2 + dx * b} ${tx},${ty}`;
  };
  lbl.select("rect").attr("x", (d) => -d.w / 2).attr("y", (d) => -d.h / 2)
    .attr("width", (d) => d.w).attr("height", (d) => d.h).attr("rx", (d) => d.h / 2);
  function draw() {
    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    qn.attr("transform", (d) => `translate(${d.x},${d.y})`);
    edge.attr("d", arc);
    qedge.attr("d", (e) => `M${e.source.x},${e.source.y}L${e.target.x},${e.target.y}`);
    if (showBeyond) bedge.attr("d", (e) => `M${e.source.x},${e.source.y}L${e.target.x},${e.target.y}`);
    hulls();
  }
  // the beyond layer is shown or hidden as a whole; nothing else is ever hidden
  function lod() {
    node.filter((d) => d.beyond).style("display", showBeyond ? null : "none");
    beG.style("display", showBeyond ? null : "none");
    draw();
  }
  const zoom = d3.zoom().scaleExtent([0.06, 4])
    .on("zoom", (e) => {
      root.attr("transform", e.transform);
      const s = Math.min(GROW, Math.max(1, 0.9 / e.transform.k));
      if (Math.abs(s - S) > 0.01) { S = s; svg.style("--s", S); }
    })
    .on("end", () => { hullCache.clear(); hullShown = undefined; draw(); });   // edge ends follow the label size
  svg.call(zoom).on("dblclick.zoom", null);
  const fit = (dur = 700) => {
    const pts = ALL.filter(visible).map((d) => L[mode][d.id]).filter(Boolean);
    const x0 = d3.min(pts, (p) => p[0]) - 80, x1 = d3.max(pts, (p) => p[0]) + 80;
    const y0 = d3.min(pts, (p) => p[1]) - 60, y1 = d3.max(pts, (p) => p[1]) + 60;
    const s = Math.min(1.2, 0.97 * Math.min(W / (x1 - x0), (H - 90) / (y1 - y0)));
    svg.transition().duration(dur).call(zoom.transform,
      d3.zoomIdentity.translate(W / 2 - s * (x0 + x1) / 2, (H + 30) / 2 - s * (y0 + y1) / 2).scale(s));
  };
  function layout(m, dur = 900) {
    mode = m;
    d3.selectAll(".seg button").classed("on", function () { return this.dataset.l === m; });
    ALL.forEach((d) => { d.x0 = d.x; d.y0 = d.y; [d.x1, d.y1] = L[m][d.id] || [d.x || 0, d.y || 0]; });
    axes(); hullCache.clear();
    if (!dur) { ALL.forEach((d) => { d.x = d.x1; d.y = d.y1; }); draw(); fit(0); return; }
    const t = d3.timer((el) => {
      const u = Math.min(1, el / dur), e = d3.easeCubicInOut(u);
      ALL.forEach((d) => { d.x = d.x0 + (d.x1 - d.x0) * e; d.y = d.y0 + (d.y1 - d.y0) * e; });
      moving = u < 1; hullCache.clear(); draw();
      if (u >= 1) t.stop();
    });
    fit(dur);
  }
  function axes() {
    axisG.selectAll("*").remove();
    if (mode === "time") {
      const x = d3.scalePoint().domain(decks.map((d) => d.id)).range([0, decks.length * COLW]);
      decks.forEach((d) => {
        const ys = N.filter((n) => n.deck === d.id).map((n) => (L.time[n.id] || [0, 0])[1]);
        axisG.append("text").attr("x", x(d.id)).attr("y", (d3.max(ys) || 0) + 48).attr("text-anchor", "middle")
          .attr("fill", col(d.id)).text(d.title.split(":")[0].slice(0, 24));
      });
    }
    if (mode === "depth") {
      const maxD = d3.max(N, (d) => d._depth);
      d3.range(0, maxD + 1).forEach((j) => {
        const r = RING.mid[j];
        axisG.append("circle").attr("class", "ring").attr("r", r);
        axisG.append("text").attr("x", 6).attr("y", -r - 6).text(j === 0 ? "starting points" : `${j} step${j > 1 ? "s" : ""} in`);
      });
    }
  }
  // one lecture's area at a time: the lecture in focus
  const hullLine = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.6));
  const hullCache = new Map(), members = d3.group(N, (n) => n.deck);
  const hullPath = (id) => {
    if (!hullCache.has(id)) {
      const pts = (members.get(id) || []).flatMap((n) => { const [w, h] = box(n);
        return [[n.x - w / 2 - 10, n.y - h / 2 - 8], [n.x + w / 2 + 10, n.y - h / 2 - 8],
                [n.x - w / 2 - 10, n.y + h / 2 + 8], [n.x + w / 2 + 10, n.y + h / 2 + 8]]; });
      hullCache.set(id, pts.length >= 3 ? hullLine(d3.polygonHull(pts)) : null);
    }
    return hullCache.get(id);
  };
  let hullShown = undefined;
  function hulls() {
    const id = hullDeck && mode === "web" ? hullDeck : null;
    if (id === hullShown && !moving) return;
    hullShown = id;
    const data = id && hullPath(id) ? [{ id, d: hullPath(id) }] : [];
    hullG.selectAll("path").data(data, (o) => o.id).join("path").attr("class", "hull").attr("d", (o) => o.d)
      .attr("fill", (o) => col(o.id)).attr("fill-opacity", 0.08).attr("stroke", (o) => col(o.id)).attr("stroke-opacity", 0.5);
  }

  // ---------------------------------------------------------------- focus: back to the basics, forward to what it unlocks
  const walk = (d, key) => {
    const s = new Set(), st = [d];
    while (st.length) for (const x of st.pop()[key] || []) if (!s.has(x)) { s.add(x); st.push(x); }
    return s;
  };
  // each concept's edges, so a hover touches only the elements on its chain
  const edgeEls = edge.nodes(), bedgeEls = bedge.nodes(), qedgeEls = qedge.nodes();
  const nodeEl = new Map(node.nodes().map((el) => [el.__data__, el]));
  const qEl = new Map(qn.nodes().map((el) => [el.__data__, el]));
  const chains = new Map();
  function chain(d) {
    if (chains.has(d)) return chains.get(d);
    let up, down;
    if (d.beyond) { up = new Set(d.near.map((k) => byId.get(k))); down = new Set(); }
    else { up = walk(d, "pre"); down = walk(d, "post"); }
    const set = new Set([d, ...up, ...down]);
    if (!d.beyond) B.forEach((b) => { if (b.near.includes(d.id)) set.add(b); });
    const els = [], cls = [];
    set.forEach((n) => els.push(nodeEl.get(n)));
    edgeEls.forEach((el) => {
      const e = el.__data__;
      if (!(set.has(e.source) && set.has(e.target))) return;
      els.push(el);
      if (up.has(e.source) && (e.target === d || up.has(e.target))) cls.push([el, "up"]);
      else if ((e.source === d || down.has(e.source)) && down.has(e.target)) cls.push([el, "down"]);
    });
    bedgeEls.forEach((el) => { const e = el.__data__; if (set.has(e.source) && set.has(e.target)) els.push(el); });
    qedgeEls.forEach((el) => { if (set.has(el.__data__.target)) els.push(el); });
    Q.forEach((q) => { if (q.teaches.some((c) => set.has(byId.get(c)))) els.push(qEl.get(q)); });
    const c = { set, els: els.filter(Boolean), cls };
    chains.set(d, c);
    return c;
  }
  // a pinned concept's chain stays lit while another is hovered: the two show together
  let shown = [];
  function focus(d) {
    hullDeck = d && !d.beyond ? d.deck : null;
    shown.forEach((c) => { c.els.forEach((el) => el.classList.remove("lit")); c.cls.forEach(([el, k]) => el.classList.remove(k)); });
    shown = [pinned, d].filter((x, i, a) => x && a.indexOf(x) === i).map(chain);
    lit = new Set(shown.flatMap((c) => [...c.set]));
    shown.forEach((c) => { c.els.forEach((el) => el.classList.add("lit")); c.cls.forEach(([el, k]) => el.classList.add(k)); });
    root.classed("focusing", shown.length > 0);
    hulls();
    if (!d) plan();
  }
  // lectures switched off in the legend: rare, so a full pass is fine
  function dimOff() {
    node.classed("faded", (n) => !n.beyond && off.has(n.deck));
    edge.classed("faded", (e) => off.has(e.source.deck) || off.has(e.target.deck));
  }
  const conceptLink = (x) => `<b data-k="${esc(x.id)}">${esc(x.name)}</b>`;
  function panel(d) {
    const p = d3.select("#panel").classed("on", !!d);
    if (!d) return;
    if (d.beyond) {
      const q = `What is ${d.name}, and how does it connect to ${d.near.length ? byId.get(d.near[0]).name : "the course"}?`;
      p.html(`<button class="x" aria-label="Close">×</button>
        <span class="kick">${d.role === "basis" ? "A foundation the courses rest on" : "Where the courses lead"}</span>
        <h2>${esc(d.article)}</h2>${d.about ? `<p class="def">${esc(d.about)}</p>` : ""}
        <div class="chain">Next to ${d.near.map((k) => conceptLink(byId.get(k))).join(", ")} in the courses.</div>
        ${d.named.length ? `<div class="chain">Its name appears in the lesson title "${esc(d.named[0])}": it may be taught already without a concept tag.</div>` : ""}
        <div class="acts" style="margin-top:12px">
          <a class="btn go" href="/q?q=${encodeURIComponent(q)}" target="_blank" rel="noopener">Explore it on the map</a>
          <a class="btn" href="https://en.wikipedia.org/wiki/${encodeURIComponent(d.article.replace(/ /g, "_"))}" target="_blank" rel="noopener">Wikipedia</a></div>`);
    } else {
      const deck = decks[di[d.deck]], up = walk(d, "pre"), down = walk(d, "post");
      const basics = [...up].filter((x) => !x.pre.length);
      p.html(`<button class="x" aria-label="Close">×</button>
        <h2>${esc(d.name)}</h2><div class="deck" style="color:${col(d.deck)}">${esc(deck.title)}</div>
        ${d.definition ? `<p class="def">${esc(d.definition)}</p>` : ""}
        <dl><dt>taught in</dt><dd>${esc(d.lesson || deck.title)}</dd>
          <dt>built on</dt><dd>${up.size} concept${up.size === 1 ? "" : "s"}${basics.length ? `, from ${basics.slice(0, 4).map(conceptLink).join(", ")}` : ""}</dd>
          <dt>unlocks</dt><dd>${down.size} concept${down.size === 1 ? "" : "s"}</dd>
          ${d.previewed.length ? `<dt>glimpsed in</dt><dd>${esc(d.previewed.join(", "))}</dd>` : ""}
          ${d.wiki ? `<dt>Wikipedia</dt><dd>${esc(d.wiki)}${d.closest ? ` <span class="closest">(covers it as part of a broader topic)</span>` : ""}</dd>` : ""}</dl>
        <div class="acts"><a class="btn go" href="${esc(d.url)}" target="_blank" rel="noopener">Open the lesson</a>
          <a class="btn" href="/q?concept=${encodeURIComponent(d.id)}" target="_blank" rel="noopener">On the map</a>
          ${d.wiki ? `<a class="btn" href="https://en.wikipedia.org/wiki/${encodeURIComponent(d.wiki.replace(/ /g, "_"))}" target="_blank" rel="noopener">Wikipedia</a>` : ""}</div>
        ${d.pre.length ? `<div class="chain">Needs first: ${d.pre.map(conceptLink).join(", ")}</div>` : '<div class="chain">A starting point: it needs nothing taught before it.</div>'}`);
    }
    p.select(".x").on("click", () => { pinned = null; node.classed("pin", false); focus(null); panel(null); });
    p.selectAll("[data-k]").on("click", function () { goTo(byId.get(this.dataset.k)); });
  }
  function goTo(d) {
    if (!d) return;
    pinned = d; node.classed("pin", (n) => n === pinned); focus(d); panel(d);
    const s = 1.1;
    svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(W / 2 - s * d.x, H / 2 - s * d.y).scale(s));
  }
  node.on("mouseenter", (e, d) => focus(d)).on("mouseleave", () => focus(pinned))
    .on("click", (e, d) => {
      if (planning && !d.beyond) { known.has(d.id) ? known.delete(d.id) : known.add(d.id); saveKnown(); return; }
      pinned = pinned === d ? null : d; node.classed("pin", (n) => n === pinned); focus(pinned); panel(pinned);
    })
    .on("dblclick", (e, d) => open(d.beyond ? `https://en.wikipedia.org/wiki/${encodeURIComponent(d.article.replace(/ /g, "_"))}` : d.url, "_blank", "noopener"));
  node.call(d3.drag().on("drag", (e, d) => { d.x = e.x; d.y = e.y; hullCache.delete(d.deck); moving = true; draw(); moving = false; }));

  // ---------------------------------------------------------------- legend: hover a lecture to see its area, click to hide it
  const COURSES = { intro_ml: "Introduction to Machine Learning", ml4science: "ML for Science", other: "Other lessons" };
  const LEG = "sa-legend";
  let legOpen = true;
  try { legOpen = localStorage.getItem(LEG) !== "closed"; } catch (e) {}
  const setLegend = (on) => {
    legOpen = on; $("legend").hidden = !on; $("legendTab").hidden = on;
    try { localStorage.setItem(LEG, on ? "open" : "closed"); } catch (e) {}
  };
  $("legendTab").addEventListener("click", () => setLegend(true));
  function legend() {
    const leg = d3.select("#legend").html("");
    leg.append("li").attr("class", "head").html(`<span>Lectures</span><button class="x" type="button" aria-label="Hide the lectures">×</button>`)
      .select("button").on("click", () => setLegend(false));
    Object.keys(inCourse).forEach((c) => {
      leg.append("li").attr("class", "cap").text(COURSES[c] || c);
      inCourse[c].forEach((id) => {
        const d = decks[di[id]];
        leg.append("li").attr("tabindex", 0).classed("off", off.has(id))
          .html(`<i style="background:${col(id)}"></i><span>${esc(d.title)}</span><span class="n">${N.filter((n) => n.deck === id).length}</span>`)
          .on("mouseenter", () => { if (!pinned) { hullDeck = id; hulls(); } })
          .on("mouseleave", () => { if (!pinned) { hullDeck = null; hulls(); } })
          .on("click keydown", function (e) {
            if (e.type === "keydown" && e.key !== "Enter") return;
            off.has(id) ? off.delete(id) : off.add(id); this.classList.toggle("off"); dimOff();
          });
      });
    });
  }
  legend(); setLegend(legOpen);

  // ---------------------------------------------------------------- plan my path
  function status(d) {
    if (known.has(d.id)) return "known";
    return d.pre.every((p) => known.has(p.id)) ? "ready" : "locked";
  }
  const inReach = (b) => b.near.length > 0 && b.near.every((k) => known.has(k));
  function saveKnown() {
    try { localStorage.setItem(KNOWN, JSON.stringify([...known])); } catch (e) {}
    plan();
  }
  function plan() {
    document.body.classList.toggle("planning", planning);
    node.classed("known", (d) => planning && !d.beyond && status(d) === "known")
      .classed("ready", (d) => planning && !d.beyond && status(d) === "ready")
      .classed("locked", (d) => planning && !d.beyond && status(d) === "locked")
      .classed("reach", (d) => planning && d.beyond && inReach(d));
    if (!planning) return;
    const ready = N.filter((d) => status(d) === "ready").sort((a, b) => a._depth - b._depth || di[a.deck] - di[b.deck]);
    $("planStats").textContent = `${known.size} of ${N.length} concepts known · ${ready.length} ready to learn next`;
    $("readyList").innerHTML = ready.slice(0, 40).map((d) => `<li data-k="${esc(d.id)}"><span class="nm">${esc(d.name)}</span>
      <a class="sc" href="${esc(d.url)}" target="_blank" rel="noopener">lesson</a><span class="nr">${esc(decks[di[d.deck]].title)}</span></li>`).join("");
    const reach = B.filter(inReach).slice(0, 20);
    $("reachList").innerHTML = reach.length ? reach.map((b) => `<li data-b="${esc(b.id)}"><span class="nm">${esc(b.article)}</span>
      <span class="sc">${b.role === "basis" ? "foundation" : "next"}</span></li>`).join("")
      : `<li class="empty">Mark what you know to see what opens up beyond the courses.</li>`;
    $("readyList").querySelectorAll("li[data-k]").forEach((li) => li.addEventListener("click", (e) => {
      if (e.target.tagName !== "A") goTo(byId.get(li.dataset.k));
    }));
    $("reachList").querySelectorAll("li[data-b]").forEach((li) => li.addEventListener("click", () => {
      if (!showBeyond) { $("showBeyond").checked = true; showBeyond = true; lod(); }
      goTo(B.find((b) => b.id === li.dataset.b));
    }));
  }
  decks.forEach((d) => {
    const o = document.createElement("option");
    o.value = d.i;
    o.textContent = `${(COURSES[d.course] || d.course).replace("Introduction to Machine Learning", "Intro to ML")}: ${d.title}`;
    $("upTo").appendChild(o);
  });
  $("upTo").addEventListener("change", (e) => {
    const upto = +e.target.value;
    if (Number.isNaN(upto)) return;
    const target = decks[upto];
    decks.slice(0, upto + 1).filter((d) => d.course === target.course)
      .forEach((d) => N.filter((n) => n.deck === d.id).forEach((n) => known.add(n.id)));
    e.target.value = "";
    saveKnown();
  });
  $("clearKnown").addEventListener("click", () => { known.clear(); saveKnown(); });

  // ---------------------------------------------------------------- beyond the courses: ranked list
  let filter = "all";
  function beyondList() {
    const all = G.nodes.filter((n) => n.type === "beyond");
    const items = all.filter((x) => filter === "all" || (filter === "named" ? (x.named_in || []).length : x.role === filter)).slice(0, 100);
    $("beyondList").innerHTML = items.map((x) => `<li data-b="${esc(x.id)}"><span class="nm">${esc(x.article)}</span>
      <span class="sc">${(x.score || 0).toFixed(1)}</span>
      <span class="nr">${x.role === "basis" ? "foundation for" : "next after"} ${esc((near[x.id] || []).slice(0, 3)
        .map((k) => byId.get(k)?.name || k).join(", "))}</span></li>`).join("");
    $("beyondList").querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
      const b = B.find((x) => x.id === li.dataset.b);
      if (!b) return;
      if (!showBeyond) { $("showBeyond").checked = true; showBeyond = true; lod(); }
      goTo(b);
    }));
    const c = (t) => G.edges.filter((e) => e.type === t).length;
    $("method").textContent = `${N.length} concepts in ${decks.length} decks · ${c("prereq")} prerequisites · ` +
      `${all.length} articles beyond, from ${G.sources?.frontier_model || "a small model"} reading each concept's Wikipedia article. Built ${G.built}. Data: /learn/graph.json.`;
  }
  beyondList();
  $("tabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    $("tabs").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    filter = b.dataset.f; beyondList();
  }));

  // ---------------------------------------------------------------- controls
  const sidePanel = (id, on) => {
    ["planPanel", "beyondPanel"].forEach((p) => { $(p).hidden = p !== id || !on; });
    $("planBtn").classList.toggle("on", id === "planPanel" && on);
    $("beyondBtn").classList.toggle("on", id === "beyondPanel" && on);
    planning = id === "planPanel" && on;
    d3.select("#panel").classed("on", false); pinned = null;
    plan(); focus(null);
  };
  $("planBtn").addEventListener("click", () => sidePanel("planPanel", $("planPanel").hidden));
  $("beyondBtn").addEventListener("click", () => sidePanel("beyondPanel", $("beyondPanel").hidden));
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => sidePanel(b.dataset.close, false)));
  d3.selectAll(".seg button").on("click", function () { layout(this.dataset.l); });
  $("showStories").addEventListener("change", function () {
    qG.style("display", this.checked ? null : "none"); qeG.style("display", this.checked ? null : "none");
  });
  $("showBeyond").addEventListener("change", function () { showBeyond = this.checked; lod(); });
  $("find").addEventListener("input", function () {
    const t = this.value.trim().toLowerCase();
    const hit = t && (N.find((n) => n.name.toLowerCase() === t) ||
      N.find((n) => n.name.toLowerCase().includes(t) || (n.wiki || "").toLowerCase().includes(t)));
    if (hit) goTo(hit);
    else if (!t) { pinned = null; node.classed("pin", false); focus(null); panel(null); }
  });
  $("themeBtn").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("sa-theme", next); } catch (e) {}
    markers(); paint(); legend(); hullShown = undefined; hulls(); axes();
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { pinned = null; node.classed("pin", false); focus(null); panel(null); } });
  addEventListener("resize", () => { W = innerWidth; H = innerHeight; fit(0); });
  const fromHash = () => { const m = location.hash.match(/c=([\w-]+)/); if (m && byId.has(m[1])) goTo(byId.get(m[1])); };
  addEventListener("hashchange", fromHash);

  ALL.forEach((d) => { [d.x, d.y] = L.web[d.id] || [0, 0]; });
  layout("web", 0); lod(); focus(null);
  setTimeout(fromHash, 300);
})();
