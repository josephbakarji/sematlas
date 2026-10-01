/**
 * SemAtlas question page.
 *
 * POST /explore streams the exploration (see backend/explore.py). The graph
 * grows as Jev picks articles; each node is a box with the article's title in
 * it, as on the main SemAtlas page. A node's hue says which starting article
 * it grew from; its brightness says how strongly its intro answers the
 * current question. Candidates (links Jev ranked but did not follow) are
 * dashed outlines.
 *
 * Clicking a node adds it to, or removes it from, the sources of the latest
 * answer; a bar then offers to rewrite it (POST /explore/rewrite). A
 * follow-up question sends the graph back so it keeps growing, and its answer
 * is added below the previous one.
 *
 * The graph zooms (ctrl/pinch, or freely in full view) and pans by dragging
 * the background. The first question lives in ?q= so a page can be shared.
 */

const state = {
  nodes: new Map(),   // id -> node (d3 keeps x/y on these)
  links: [],
  evidence: null,     // id -> probability for the latest question
  answers: [],        // one per question asked, oldest first
  context: new Set(), // articles the next rewrite of the latest answer would use
  seedOrder: [],      // starting articles in order of appearance: fixes their hue
  controller: null,
  busy: false,
};

// ------------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const money = (x) => (x == null ? "not reported" : "$" + x.toFixed(x < 0.01 ? 5 : 4));
const cur = () => state.answers[state.answers.length - 1];
const isDark = () => document.documentElement.getAttribute("data-theme") !== "light";

function score(d) {
  return state.evidence ? (state.evidence[d.id] ?? 0) : null;
}

// ------------------------------------------------------------------ colour

// Branch hues, in a fixed order: the first starting article is always blue,
// the second orange, and so on. Each mode has its own validated steps.
const HUES = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"],
};

function branchOf(d) {
  let n = d;
  for (let i = 0; i < 30 && n && !n.seed && n.parent; i++) n = state.nodes.get(n.parent);
  return n && n.seed ? n.id : null;
}

function hueOf(d) {
  const i = state.seedOrder.indexOf(branchOf(d));
  const hues = HUES[isDark() ? "dark" : "light"];
  return hues[Math.max(0, i) % hues.length];
}

function fill(d) {
  if (d.status === "candidate") return css("--bg");
  const s = score(d);
  // before scoring, a gentle tint by link ranking; after, relevance sets brightness
  const t = s === null ? 0.3 + 0.35 * (d.route || 0) : 0.1 + 0.9 * Math.pow(s, 0.9);
  return d3.interpolateRgb(css("--node"), hueOf(d))(t);
}

function textColor(d) {
  if (d.status === "candidate") return css("--ink-dim");
  return d3.lab(fill(d)).l > 60 ? "#12151b" : "#f4f6f9";
}

// ------------------------------------------------------------------ graph

const svg = d3.select("#graph");
const root = svg.append("g");
const linkLayer = root.append("g");
const nodeLayer = root.append("g");
let viewBox = null;
let zoomK = 1;
let fullView = false;

const zoomer = d3.zoom()
  .scaleExtent([0.5, 8])
  // in the page, the wheel scrolls the article; zoom only with ctrl (and the
  // trackpad pinch, which arrives as ctrl+wheel). In full view it just zooms.
  .filter((ev) => {
    if (ev.type === "wheel") return fullView || ev.ctrlKey || ev.metaKey;
    if (ev.type === "dblclick") return false;
    return !ev.button;
  })
  .on("start", (ev) => { if (ev.sourceEvent && ev.sourceEvent.type === "wheel") zoomUsed(); })
  .on("zoom", (ev) => {
    root.attr("transform", ev.transform);
    zoomK = ev.transform.k;
    updateFocus();
  });
svg.call(zoomer);

let zoomTracked = false;
function zoomUsed() { if (!zoomTracked) { zoomTracked = true; track("zoom"); } }

function fontSize(d) {
  if (d.seed) return 20;
  if (d.status === "candidate") return 12;
  return d.level === 1 ? 15 : 13.5;
}

// Boxes do not overlap: push each pair apart along the axis where they
// overlap least. Quadratic, which is fine for the ~150 nodes a session makes.
// The push does not fade with the simulation's alpha, so overlaps left when
// the layout cools still get resolved.
function rectCollide(padding = 6) {
  let nodes = [];
  function force() {
    const strength = 0.5;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = (a.w + b.w) / 2 + padding - Math.abs(dx);
        const oy = (a.h + b.h) / 2 + padding - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox < oy) {
            const m = (ox / 2) * strength * (dx < 0 ? -1 : 1);
            a.x -= m; b.x += m;
          } else {
            const m = (oy / 2) * strength * (dy < 0 ? -1 : 1);
            a.y -= m; b.y += m;
          }
        }
      }
    }
  }
  force.initialize = (n) => { nodes = n; };
  return force;
}

const sim = d3.forceSimulation()
  .force("charge", d3.forceManyBody().strength(-420))
  .force("link", d3.forceLink().id((d) => d.id)
    .distance((l) => (l.kind === "cross" ? 180 : 95))
    .strength((l) => (l.kind === "cross" ? 0.04 : 0.5)))
  .force("collide", rectCollide())
  .force("x", d3.forceX(0).strength(0.035))
  .force("y", d3.forceY(0).strength(0.07))
  .on("tick", ticked);

function updateGraph(snapshot) {
  snapshot.nodes.forEach((n) => {
    const old = state.nodes.get(n.id);
    if (old) {
      Object.assign(old, n);
    } else {
      // enter next to the parent, so growth reads as branching
      const p = n.parent && state.nodes.get(n.parent);
      const spread = state.nodes.size ? 400 : 300;
      state.nodes.set(n.id, {
        ...n, w: 60, h: 20,
        x: p ? p.x + (Math.random() - 0.5) * 60 : (Math.random() - 0.5) * spread,
        y: p ? p.y + (Math.random() - 0.5) * 60 : (Math.random() - 0.5) * spread * 0.5,
      });
    }
    if (n.seed && !state.seedOrder.includes(n.id)) state.seedOrder.push(n.id);
  });
  state.links = snapshot.links.map((l) => ({ ...l }));
  draw();
  updateLegend();
  sim.alpha(0.9).restart();
}

function draw() {
  const nodes = [...state.nodes.values()];
  sim.nodes(nodes);
  sim.force("link").links(state.links);

  linkLayer.selectAll("line")
    .data(state.links, (l) => `${l.source.id || l.source}|${l.target.id || l.target}`)
    .join("line")
    .attr("class", (l) => "g-link " + l.kind);

  nodeLayer.selectAll("g.g-node")
    .data(nodes, (d) => d.id)
    .join((enter) => {
      const e = enter.append("g").attr("class", "g-node new");
      e.append("rect").attr("rx", 5);
      e.append("text").attr("text-anchor", "middle").attr("dy", "0.35em")
        .text((d) => d.id);
      e.on("mouseenter", (ev, d) => showTip(ev, nodeTip(d)))
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip)
        .on("click", (ev, d) => toggleContext(ev, d))
        .on("dblclick", (ev, d) => { track("open_wikipedia"); window.open(d.url, "_blank", "noopener"); })
        .call(d3.drag()
          .on("start", (ev, d) => { if (!ev.active) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
          .on("drag", (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
          .on("end", (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
      setTimeout(() => e.classed("new", false), 600);
      return e;
    });
  restyle();
}

function restyle() {
  const g = nodeLayer.selectAll("g.g-node");
  g.classed("seed", (d) => d.seed)
    .classed("candidate", (d) => d.status === "candidate")
    .classed("in-context", (d) => state.context.has(d.id));
  g.select("text")
    .style("font-size", (d) => fontSize(d) + "px")
    .style("fill", textColor);
  // size each box to its label
  g.each(function (d) {
    const b = d3.select(this).select("text").node().getBBox();
    d.w = b.width + 14;
    d.h = b.height + 8;
  });
  g.select("rect")
    .attr("x", (d) => -d.w / 2).attr("y", (d) => -d.h / 2)
    .attr("width", (d) => d.w).attr("height", (d) => d.h)
    .style("fill", fill)
    .style("stroke", (d) => (state.context.has(d.id) ? null
      : d.status === "candidate" ? hueOf(d) : "none"));
  linkLayer.selectAll("line").classed("faded", (l) => {
    if (!state.evidence) return false;
    const a = state.evidence[l.source.id] ?? 0, b = state.evidence[l.target.id] ?? 0;
    return a < 0.3 && b < 0.3;
  });
  updateContextBar();
}

function updateLegend() {
  const hues = HUES[isDark() ? "dark" : "light"];
  const seeds = state.seedOrder.filter((id) => state.nodes.has(id));
  $("legendSeeds").innerHTML = seeds.slice(0, hues.length).map((id, i) =>
    `<span class="swatch" style="background:${hues[i]}"></span>${esc(id)}`).join("");
}

let tickCount = 0;
function ticked() {
  linkLayer.selectAll("line")
    .attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y)
    .attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y);
  nodeLayer.selectAll("g.g-node").attr("transform", nodeTransform);
  if (tickCount++ % 3 === 0) fitView();
}

// Fit the drawing to the box with a viewBox, eased so it does not jump. The
// box shrinks as the reader scrolls and the drawing scales with it. The
// reader's own zoom sits on top of this, on the root group.
function fitView() {
  const nodes = [...state.nodes.values()];
  if (!nodes.length) return;
  const pad = 30;
  const x0 = d3.min(nodes, (d) => d.x - d.w / 2) - pad, x1 = d3.max(nodes, (d) => d.x + d.w / 2) + pad;
  const y0 = d3.min(nodes, (d) => d.y - d.h / 2) - pad, y1 = d3.max(nodes, (d) => d.y + d.h / 2) + pad;
  const target = [x0, y0, Math.max(x1 - x0, 400), Math.max(y1 - y0, 220)];
  viewBox = viewBox ? viewBox.map((v, i) => v + (target[i] - v) * 0.2) : target;
  svg.attr("viewBox", viewBox.join(" ")).attr("preserveAspectRatio", "xMidYMid meet");
  updateFocus();
}

// Short of room (the graph squeezed while reading, or a phone), the whole
// layout stays but only its core stays legible: the answer's sources, the
// starting articles and strong evidence are drawn larger, the rest fades.
// Zooming in gives the room back, so the enlargement eases off with zoom.
let coreScale = 1;
function updateFocus() {
  const el = svg.node();
  if (!viewBox || !el.clientWidth) return;
  const tight = !!state.evidence && !fullView &&
    (document.body.classList.contains("compact") || el.clientWidth < 700);
  const k = Math.max(viewBox[2] / el.clientWidth, viewBox[3] / el.clientHeight) / zoomK;
  coreScale = tight ? Math.min(el.clientWidth < 700 ? 2.2 : 3.2, Math.max(1, k * 0.9)) : 1;
  const inCore = (d) => d.seed || state.context.has(d.id) || (state.evidence?.[d.id] ?? 0) >= 0.6;
  const core = [];
  nodeLayer.selectAll("g.g-node").each((d) => {
    d.core = tight && inCore(d);
    d.ox = 0; d.oy = 0;
    if (d.core) core.push(d);
  });
  // enlarged boxes can land on each other; nudge them apart for display only,
  // leaving the layout itself alone
  if (coreScale > 1) {
    for (let it = 0; it < 40; it++) {
      let moved = false;
      for (let i = 0; i < core.length; i++) {
        for (let j = i + 1; j < core.length; j++) {
          const a = core[i], b = core[j];
          const dx = (b.x + b.ox) - (a.x + a.ox), dy = (b.y + b.oy) - (a.y + a.oy);
          const ox = ((a.w + b.w) / 2) * coreScale + 4 - Math.abs(dx);
          const oy = ((a.h + b.h) / 2) * coreScale + 3 - Math.abs(dy);
          if (ox > 0 && oy > 0) {
            moved = true;
            if (oy < ox) { const m = oy / 2 * (dy < 0 ? -1 : 1); a.oy -= m; b.oy += m; }
            else { const m = ox / 2 * (dx < 0 ? -1 : 1); a.ox -= m; b.ox += m; }
          }
        }
      }
      if (!moved) break;
    }
    if (zoomK === 1) {   // keep them inside the frame
      const [vx, vy, vw, vh] = viewBox;
      core.forEach((d) => {
        const hw = (d.w * coreScale) / 2 + 4, hh = (d.h * coreScale) / 2 + 2;
        const cx = Math.min(Math.max(d.x + d.ox, vx + hw), vx + vw - hw);
        const cy = Math.min(Math.max(d.y + d.oy, vy + hh), vy + vh - hh);
        d.ox = cx - d.x; d.oy = cy - d.y;
      });
    }
  }
  nodeLayer.selectAll("g.g-node")
    .classed("faint", (d) => tight && !d.core)
    .classed("core", (d) => d.core)
    .attr("transform", nodeTransform);
  nodeLayer.selectAll("g.g-node.core").raise();
}

function nodeTransform(d) {
  if (coreScale > 1 && d.core) {
    return `translate(${d.x + (d.ox || 0)},${d.y + (d.oy || 0)}) scale(${coreScale})`;
  }
  return `translate(${d.x},${d.y})`;
}

function setFullView(on) {
  fullView = on;
  if (on) track("fullview");
  document.body.classList.toggle("fullview", on);
  $("fullBtn").textContent = on ? "✕ Close full view" : "⤢ Full view";
  hideTip();
  onScroll();
}

function resetZoom() {
  svg.transition().duration(400).call(zoomer.transform, d3.zoomIdentity);
}

function nodeTip(d) {
  const s = score(d);
  const lines = [`<b>${esc(d.id)}</b>`];
  if (d.about) lines.push(`<i>${esc(d.about)}</i>`);
  if (d.seed) lines.push("Starting article, chosen from the search results");
  else if (d.status === "candidate") lines.push(`Linked from ${esc(d.parent)}, not followed`);
  else if (d.parent) lines.push(`Followed from ${esc(d.parent)}`);
  lines.push(`Link ranking ${(d.route ?? 0).toFixed(2)}` +
    (s !== null ? ` · evidence ${s.toFixed(2)}` : ""));
  lines.push(state.context.has(d.id)
    ? "In the answer's sources. Click to remove."
    : "Click to add to the answer's sources.");
  lines.push("Double-click to open on Wikipedia.");
  return lines.join("<br>");
}

function pulseNode(id) {
  const g = nodeLayer.selectAll("g.g-node").filter((d) => d.id === id);
  g.raise().classed("pulse", false);
  void g.node()?.getBBox();
  g.classed("pulse", true);
  setTimeout(() => g.classed("pulse", false), 2500);
}

// ------------------------------------------------------------------ context

function toggleContext(ev, d) {
  const a = cur();
  if (state.busy || !a || !a.sources.length) return;
  if (state.context.has(d.id)) { state.context.delete(d.id); track("node_remove"); }
  else { state.context.add(d.id); track("node_add"); }
  restyle();
  showTip(ev, nodeTip(d));
}

function contextChanged() {
  const used = new Set((cur()?.sources || []).map((s) => s.name));
  if (used.size !== state.context.size) return true;
  for (const t of state.context) if (!used.has(t)) return true;
  return false;
}

function updateContextBar() {
  const bar = $("contextBar");
  const a = cur();
  const show = !state.busy && a && a.sources.length > 0 && contextChanged();
  bar.hidden = !show;
  $("fuForm").hidden = state.busy || !a || !a.done;
  if (!show) return;
  const used = new Set(a.sources.map((s) => s.name));
  const added = [...state.context].filter((t) => !used.has(t)).length;
  const removed = [...used].filter((t) => !state.context.has(t)).length;
  const parts = [];
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  $("contextText").textContent = `${state.context.size} sources selected (${parts.join(", ")})`;
  $("rewriteBtn").disabled = state.context.size === 0;
}

// ------------------------------------------------------------------ tooltip

function showTip(ev, html) { const t = $("tip"); t.innerHTML = html; t.hidden = false; moveTip(ev); }
function moveTip(ev) {
  const t = $("tip");
  t.style.left = Math.min(ev.clientX + 14, innerWidth - t.offsetWidth - 8) + "px";
  t.style.top = Math.min(ev.clientY + 14, innerHeight - t.offsetHeight - 8) + "px";
}
function hideTip() { $("tip").hidden = true; }

// ------------------------------------------------------------------ answers

function newAnswer(question, followupOf) {
  const el = $("answerTpl").content.firstElementChild.cloneNode(true);
  const q = (sel) => el.querySelector(sel);
  const a = {
    question, el, sources: [], tokens: [], plain: "", done: false,
    title: q(".article-title"), rank: q(".m-rank"), gen: q(".m-gen"),
    cost: q(".cost-line"), status: q(".status"), body: q(".article-body"),
    refsWrap: q(".refs"), refs: q(".refs ol"), traceWrap: q(".trace"), trace: q(".trace ol"),
  };
  a.title.textContent = question;
  if (followupOf) {
    const p = q(".followup-of");
    p.textContent = "Follow-up to: " + followupOf;
    p.hidden = false;
    q(".hint").remove();
  }
  $("answers").appendChild(el);
  state.answers.push(a);
  return a;
}

function sourceIndex(a, name) {
  const i = a.sources.findIndex((s) => s.name === name);
  return i < 0 ? 0 : i + 1;
}

// Rebuilt from the token list on every event. The answer is a few hundred
// words, so this is cheap, and it lets a "## " heading split across chunks
// render correctly once the rest arrives.
function renderBody(a) {
  let raw = "";
  a.tokens.forEach((t) => {
    raw += typeof t === "string" ? t : `\u0001${sourceIndex(a, t.cite)}\u0001`;
  });
  const blocks = raw.split(/\n\s*\n|\n(?=## )/).map((b) => b.trim()).filter(Boolean);
  a.body.innerHTML = blocks.map((b) => {
    const heading = b.startsWith("## ");
    const html = esc(heading ? b.slice(3) : b)
      .replace(/\u0001(\d+)\u0001/g, (_, n) => `<a class="cite" data-n="${n}">[${n}]</a>`);
    return heading ? `<h2>${html}</h2>` : `<p>${html}</p>`;
  }).join("");
  a.body.querySelectorAll(".cite").forEach((c) => {
    const s = a.sources[c.dataset.n - 1];
    if (!s) return;
    c.addEventListener("mouseenter", (ev) => { showTip(ev, `<b>${esc(s.name)}</b>${esc(s.excerpt)}…`); pulseNode(s.name); });
    c.addEventListener("mousemove", moveTip);
    c.addEventListener("mouseleave", hideTip);
    c.addEventListener("click", () => { hideTip(); track("cite_click"); focusRef(a, +c.dataset.n); });
  });
}

function focusRef(a, n) {
  const s = a.sources[n - 1];
  if (!s) return;
  pulseNode(s.name);
  const li = a.refs.children[n - 1];
  if (li) {
    li.scrollIntoView({ behavior: "smooth", block: "center" });
    li.classList.add("flash");
    setTimeout(() => li.classList.remove("flash"), 1600);
  }
}

function renderRefs(a) {
  a.refs.innerHTML = a.sources.map((s) => `
    <li>
      <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>
      <span class="ref-score" title="How strongly this article's intro answers the question">
        <span class="bar"><span style="width:${Math.round(s.score * 100)}%"></span></span>
        ${s.score.toFixed(2)}</span>
      <p class="ref-excerpt">${esc(s.excerpt)}…</p>
    </li>`).join("");
  a.refsWrap.hidden = !a.sources.length;
  [...a.refs.children].forEach((li, i) =>
    li.addEventListener("mouseenter", () => pulseNode(a.sources[i].name)));
}

function addTrace(a, ev) {
  const p = (x) => `<span class="p">${x.toFixed(2)}</span>`;
  let html;
  if (ev.stage === "rephrase") {
    html = `Read the follow-up as: <b>${esc(ev.standalone)}</b>`;
  } else if (ev.stage === "seeds") {
    const ranked = ev.ranked.slice(0, 6).map((r) => `${esc(r.title)} ${p(r.p)}`).join(", ");
    const kept = ev.kept.length
      ? `${ev.followup ? "Added new starting points" : "Started from"} <b>${ev.kept.map(esc).join("</b>, <b>")}</b>.`
      : "No new starting points; grew from the articles already in the graph.";
    html = `Searched Wikipedia (${ev.considered} results) and ranked them: ${ranked}. ${kept}`;
  } else {
    const kept = ev.kept.length
      ? "followed " + ev.kept.map((k) => `<b>${esc(k.title)}</b> ${p(k.p)}`).join(", ")
      : "nothing new cleared the bar";
    html = `From <b>${esc(ev.source)}</b>, ranked ${ev.considered} links; ${kept}.`;
  }
  const li = document.createElement("li");
  li.innerHTML = html;
  a.trace.appendChild(li);
  a.traceWrap.hidden = false;
}

function setModels(a, ev) {
  const fmt = (m) => `${esc(m.model)} <span class="via">via ${esc(m.via)}</span>` +
    (m.note ? ` <span class="note">(${esc(m.note)})</span>` : "");
  a.rank.innerHTML = fmt(ev.ranking);
  a.gen.innerHTML = fmt(ev.generation);
}

function setCost(a, ev, label) {
  const r = ev.ranking || {}, w = ev.writing || {};
  const rank = r.calls
    ? `ranking ${money(r.cost)} (${r.calls} Jev calls, ${(r.input_tokens || 0).toLocaleString()} input tokens)`
    : "no ranking";
  const write = w.prompt_tokens != null
    ? `writing ${money(w.cost)} (${w.prompt_tokens.toLocaleString()} tokens in, ` +
      `${w.completion_tokens.toLocaleString()} out` +
      (w.reasoning_tokens ? `, ${w.reasoning_tokens.toLocaleString()} of them reasoning` : "") + ")"
    : "writing cost not reported";
  a.cost.innerHTML = `<b>${label} ${money(ev.total)}</b>: ${rank}, ${write}. Wikipedia is free.`;
  a.cost.hidden = false;
}

function setStatus(msg) {
  const a = cur();
  if (a) a.status.textContent = msg || "";
  $("graphStatus").textContent = msg || "";
}

// ------------------------------------------------------------------ accounts
//
// Questions cost money. The site pays for a few free ones a day; beyond that
// a visitor connects their own OpenRouter account (OAuth with PKCE, so the key
// is issued straight to this browser) or pastes a key. The key lives in
// localStorage and goes out only as a header on this visitor's own requests.

const KEY_STORE = "sa-or-key";
function userKey() { try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; } }
function setUserKey(k) {
  try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch (e) {}
  refreshAccount();
}

let pending = null;   // what to run once a key is connected: {kind, question}

async function refreshAccount() {
  const btn = $("acctBtn");
  const own = !!userKey();
  btn.classList.toggle("own", own);
  $("keyConnected").hidden = !own;
  $("keyDisconnected").hidden = own;
  if (own) { btn.textContent = "Your OpenRouter ✓"; return; }
  try {
    const q = await (await fetch("/q/quota")).json();
    btn.textContent = !q.budget_left ? "Free questions used up today"
      : `${q.free_left} free question${q.free_left === 1 ? "" : "s"} left today`;
  } catch (e) { btn.textContent = "Account"; }
}

function openKeyPanel(reason) {
  $("keyReason").textContent = reason || "";
  $("keyReason").hidden = !reason;
  $("keyPanel").hidden = false;
}
function closeKeyPanel() { $("keyPanel").hidden = true; }

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function connectOpenRouter() {
  track("connect_start");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  try {
    sessionStorage.setItem("sa-pkce", verifier);
    if (pending) sessionStorage.setItem("sa-pending", JSON.stringify(pending));
  } catch (e) {}
  const back = location.origin + "/q";
  location.href = "https://openrouter.ai/auth?callback_url=" + encodeURIComponent(back) +
    "&code_challenge=" + challenge + "&code_challenge_method=S256";
}

// Back from OpenRouter with ?code=: trade it for the key, then pick up where we were.
async function finishConnect(code) {
  let verifier = "";
  try { verifier = sessionStorage.getItem("sa-pkce") || ""; } catch (e) {}
  const url = new URL(location);
  url.searchParams.delete("code");
  history.replaceState(null, "", url);
  if (!verifier) return null;
  const resp = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.key) return null;
  setUserKey(data.key);
  track("connected");
  let resume = null;
  try {
    resume = JSON.parse(sessionStorage.getItem("sa-pending") || "null");
    sessionStorage.removeItem("sa-pending");
    sessionStorage.removeItem("sa-pkce");
  } catch (e) {}
  return resume;
}

// Anonymous usage counts: an event name, nothing else.
function track(name) {
  try {
    fetch("/q/event", {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch (e) {}
}

// ------------------------------------------------------------------ streaming

async function stream(url, body, onEvent) {
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  state.busy = true;
  $("qGo").disabled = true;
  updateContextBar();
  try {
    const headers = { "Content-Type": "application/json" };
    if (userKey()) headers["X-OpenRouter-Key"] = userKey();
    const resp = await fetch(url, {
      method: "POST", headers,
      body: JSON.stringify(body),
      signal: state.controller.signal,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (err.need_key) {
        openKeyPanel(err.error);
        const e = new Error(err.error);
        e.needKey = true;
        throw e;
      }
      if (resp.status === 401 && userKey()) {
        throw new Error("OpenRouter did not accept your key. Reconnect it from the account button.");
      }
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
    setStatus("");
    pending = null;          // it ran: nothing to resume after connecting
  } catch (e) {
    if (e.name !== "AbortError") setStatus(e.message);
    if (!e.needKey) pending = null;
  } finally {
    state.busy = false;
    $("qGo").disabled = false;
    updateContextBar();
    refreshAccount();
  }
}

function handleArticleEvent(a, ev, costLabel) {
  switch (ev.type) {
    case "models": setModels(a, ev); break;
    case "status": setStatus(ev.message); break;
    case "sources":
      a.sources = ev.sources;
      state.context = new Set(ev.sources.map((s) => s.name));
      renderRefs(a); restyle();
      break;
    case "text":
      setStatus("");
      a.tokens.push(ev.text); a.plain += ev.text;
      renderBody(a);
      break;
    case "cite":
      ev.cites.forEach((c) => a.tokens.push({ cite: c.name }));
      renderBody(a);
      break;
    case "cost": setCost(a, ev, costLabel); break;
    case "done": a.done = true; break;
    case "error": setStatus(ev.message); a.done = true; break;
  }
}

function exploreHandler(a, label) {
  return (ev) => {
    if (ev.type === "turn") addTrace(a, ev);
    else if (ev.type === "graph") updateGraph(ev);
    else if (ev.type === "scores") { state.evidence = ev.scores; restyle(); }
    else handleArticleEvent(a, ev, label);
  };
}

function resetAll() {
  state.nodes.clear(); state.links = []; state.evidence = null;
  state.answers = []; state.context.clear(); state.seedOrder = [];
  viewBox = null;
  svg.call(zoomer.transform, d3.zoomIdentity);
  linkLayer.selectAll("*").remove(); nodeLayer.selectAll("*").remove();
  $("answers").innerHTML = "";
  $("legendSeeds").innerHTML = "";
  document.body.classList.remove("landing");
  $("graphWrap").hidden = false; $("page").hidden = false;
  window.scrollTo({ top: 0 });
  onScroll();
}

async function run(question) {
  question = question.trim();
  if (!question) return;
  $("qInput").value = question;
  const url = new URL(location);
  url.searchParams.set("q", question);
  history.replaceState(null, "", url);
  document.title = question + " · SemAtlas";
  resetAll();
  const a = newAnswer(question);
  pending = { kind: "question", question };
  setStatus("Starting");
  await stream("/explore", { question }, exploreHandler(a, "This answer cost"));
}

function graphPayload() {
  return {
    nodes: [...state.nodes.values()].map((n) => ({
      id: n.id, level: n.level, route: n.route, parent: n.parent, seed: n.seed,
      status: n.status, about: n.about, expanded: n.expanded, round: n.round,
    })),
    links: state.links.map((l) => ({
      source: l.source.id || l.source, target: l.target.id || l.target, kind: l.kind,
    })),
  };
}

async function followUp(question) {
  question = question.trim();
  const prev = cur();
  if (!question || !prev || state.busy) return;
  const prior = state.answers.map((x) => ({ question: x.question, answer: x.plain }));
  const a = newAnswer(question, prev.question);
  pending = { kind: "question", question: prev.question };   // a reload loses the graph
  $("fuInput").value = "";
  a.el.scrollIntoView({ behavior: "smooth", block: "start" });
  setStatus("Growing the graph");
  await stream("/explore", { question, prior, graph: graphPayload() },
    exploreHandler(a, "This follow-up cost"));
}

async function rewrite() {
  const a = cur();
  const titles = [...state.context].sort((x, y) =>
    (state.evidence?.[y] ?? 0) - (state.evidence?.[x] ?? 0));
  if (!a || !titles.length) return;
  const prior = state.answers.slice(0, -1).map((x) => ({ question: x.question, answer: x.plain }));
  a.sources = []; a.tokens = []; a.plain = ""; a.done = false;
  a.body.innerHTML = ""; a.refs.innerHTML = ""; a.refsWrap.hidden = true;
  a.el.scrollIntoView({ behavior: "smooth", block: "start" });
  await stream("/explore/rewrite", { question: a.question, titles, prior },
    (ev) => handleArticleEvent(a, ev, "This rewrite cost"));
}

// ------------------------------------------------------------------ page

// The graph gives up height as you read, one pixel per pixel scrolled, so the
// article rises with it; once compact it stays, and the text scrolls beneath.
// "Hide" takes it away entirely; "Full view" gives it the whole window.
let graphHidden = false;
function onScroll() {
  const top = $("topbar").offsetHeight;
  const max = graphHidden ? 0 : innerHeight * 0.62;
  const min = graphHidden ? 0 : innerHeight * 0.26;
  const h = Math.max(min, max - scrollY);
  const rs = document.documentElement.style;
  rs.setProperty("--top", top + "px");
  rs.setProperty("--gh", h + "px");
  rs.setProperty("--gmax", max + "px");
  document.body.classList.toggle("compact", !graphHidden && !fullView && h <= min + 24);
  document.body.classList.toggle("graph-hidden", graphHidden);
  $("expandBtn").hidden = !graphHidden || $("graphWrap").hidden;
  updateFocus();
}

function setGraphHidden(hidden) {
  // the article's top margin changes by the graph's full height; scroll by
  // the same amount so the paragraph being read stays where it is
  const before = graphHidden ? 0 : innerHeight * 0.62;
  graphHidden = hidden;
  if (hidden && fullView) setFullView(false);
  const after = graphHidden ? 0 : innerHeight * 0.62;
  window.scrollBy(0, after - before);
  onScroll();
}

addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
addEventListener("keydown", (e) => { if (e.key === "Escape" && fullView) setFullView(false); });

$("qForm").addEventListener("submit", (e) => { e.preventDefault(); run($("qInput").value); });
$("heroForm").addEventListener("submit", (e) => { e.preventDefault(); run($("heroInput").value); });
$("fuForm").addEventListener("submit", (e) => { e.preventDefault(); followUp($("fuInput").value); });
document.querySelectorAll(".example").forEach((b) =>
  b.addEventListener("click", () => run(b.textContent)));
$("rewriteBtn").addEventListener("click", rewrite);
$("collapseBtn").addEventListener("click", () => { track("hide_graph"); setGraphHidden(true); });
$("expandBtn").addEventListener("click", () => setGraphHidden(false));
$("fullBtn").addEventListener("click", () => setFullView(!fullView));
$("fitBtn").addEventListener("click", resetZoom);
$("resetCtx").addEventListener("click", () => {
  state.context = new Set((cur()?.sources || []).map((s) => s.name));
  restyle();
});

$("themeBtn").addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("sa-theme", next); } catch (e) {}
  restyle();   // node colours are computed from the theme's variables
  updateLegend();
});

$("acctBtn").addEventListener("click", () => openKeyPanel());
$("keyClose").addEventListener("click", closeKeyPanel);
$("keyPanel").addEventListener("click", (e) => { if (e.target === $("keyPanel")) closeKeyPanel(); });
$("connectBtn").addEventListener("click", connectOpenRouter);
$("disconnectBtn").addEventListener("click", () => { track("disconnect"); setUserKey(""); });
$("pasteForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const k = $("pasteKey").value.trim();
  if (!k.startsWith("sk-or-")) { $("pasteKey").setCustomValidity("An OpenRouter key starts with sk-or-"); $("pasteKey").reportValidity(); return; }
  $("pasteKey").value = "";
  setUserKey(k);
  track("paste_key");
  closeKeyPanel();
  if (pending) run(pending.question);
});
$("pasteKey").addEventListener("input", () => $("pasteKey").setCustomValidity(""));
addEventListener("keydown", (e) => { if (e.key === "Escape") closeKeyPanel(); });

onScroll();
(async () => {
  const params = new URLSearchParams(location.search);
  let resume = null;
  if (params.get("code")) resume = await finishConnect(params.get("code"));
  refreshAccount();
  const initial = resume?.question || new URLSearchParams(location.search).get("q");
  if (initial) run(initial);
})();
