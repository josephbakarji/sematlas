/**
 * Ask the graph.
 *
 * Sends the question and every node on screen to /ask, which reads each
 * article's intro, scores it as evidence (Jev), and streams back an answer
 * written from the best intros (GPT or Claude, see backend/ask.py). The graph shows the scoring as it
 * arrives: relevant nodes brighten, the rest fade, and the nodes the answer
 * actually cites get the strongest mark. Citation chips and source rows
 * focus their node.
 *
 * Highlighting is done with classes, not fill/stroke attributes, so the theme
 * toggle's recolour pass (rethemeGraph) leaves it alone.
 */

const REL_HIGH = 0.6;
const REL_MID = 0.3;

let askController = null;
let askSources = [];   // node names in the order the answer model saw them
let askScores = {};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function graphNodes() {
  return d3.select("#visualization").selectAll(".node-group").data()
    .filter((d) => d && d.name);
}

function nodeSelection(name) {
  return d3.select("#visualization").selectAll(".node-group")
    .filter((d) => d && d.name === name);
}

// called from visualized3 once something is on screen
window.onGraphDrawn = function () {
  const bar = document.getElementById("askForm");
  if (bar) bar.classList.add("ready");
};

function clearAskHighlights() {
  d3.select("#visualization").selectAll(".node-group")
    .classed("rel-high rel-mid rel-low rel-source rel-cited", false)
    .attr("data-score", null);
  d3.select("#visualization").selectAll("line").classed("rel-faded", false);
}

function applyScores(scores) {
  askScores = scores;
  const faded = new Set();
  d3.select("#visualization").selectAll(".node-group").each(function (d) {
    if (!d) return;
    const p = scores[d.name];
    const g = d3.select(this);
    if (p === undefined) return;   // an article Wikipedia had no intro for
    g.classed("rel-high", p >= REL_HIGH)
      .classed("rel-mid", p >= REL_MID && p < REL_HIGH)
      .classed("rel-low", p < REL_MID)
      .attr("data-score", p.toFixed(2));
    if (p < REL_MID) faded.add(d.name);
  });
  d3.select("#visualization").selectAll("line").classed("rel-faded", (l) => {
    const s = l.source.name || l.source, t = l.target.name || l.target;
    return faded.has(s) && faded.has(t);
  });
}

function markSources(names) {
  askSources = names;
  names.forEach((n) => nodeSelection(n).classed("rel-source", true).raise());
  renderSourceList();
}

function markCited(names) {
  names.forEach((n) => nodeSelection(n).classed("rel-cited", true).raise());
  document.querySelectorAll("#answerSources li").forEach((li) => {
    if (names.includes(li.dataset.name)) li.classList.add("cited");
  });
}

function focusNode(name) {
  const d = graphNodes().find((n) => n.name === name);
  if (!d) return;
  const svg = d3.select("#visualization");
  const k = Math.max(d3.zoomTransform(svg.node()).k, 0.8);
  // centre it in the strip left visible between the answer and article panels
  // (showNodeInfo below opens the article panel if it is not already open)
  const left = document.getElementById("answerPanel").classList.contains("open")
    ? document.getElementById("answerPanel").offsetWidth : 0;
  const info = document.getElementById("infoPanel");
  const right = info ? info.offsetWidth : 0;
  const cx = (left + window.innerWidth - right) / 2;
  svg.transition().duration(ZOOM_SEARCH_DURATION).call(
    zoom.transform,
    d3.zoomIdentity
      .translate(cx - d.x * k, window.innerHeight / 2 - d.y * k)
      .scale(k)
  );
  d3.select("#visualization").selectAll(".node-group").classed("selected", false);
  nodeSelection(name).classed("selected", true);
  showNodeInfo(d);
}

function renderSourceList() {
  const ul = document.getElementById("answerSources");
  ul.innerHTML = askSources.map((n, i) => {
    const p = askScores[n] || 0;
    return `<li data-name="${escapeHtml(n)}">
      <span class="src-num">${i + 1}</span>
      <span class="src-name">${escapeHtml(n)}</span>
      <span class="src-bar"><span style="width:${Math.round(p * 100)}%"></span></span>
    </li>`;
  }).join("");
  ul.querySelectorAll("li").forEach((li) =>
    li.addEventListener("click", () => focusNode(li.dataset.name)));
  document.getElementById("answerSourcesWrap").hidden = !askSources.length;
}

function setStatus(msg) {
  const el = document.getElementById("answerStatus");
  el.textContent = msg || "";
  el.hidden = !msg;
}

function appendText(t) {
  const body = document.getElementById("answerText");
  body.appendChild(document.createTextNode(t));
}

function appendCites(cites) {
  const body = document.getElementById("answerText");
  const seen = new Set();
  cites.forEach((c) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cite-chip";
    chip.textContent = askSources.indexOf(c.name) + 1 || "?";
    chip.title = c.quote ? `${c.name}: "${c.quote.trim()}"` : c.name;
    chip.addEventListener("click", () => focusNode(c.name));
    body.appendChild(chip);
  });
  markCited([...seen]);
}

function openAnswerPanel(question) {
  const panel = document.getElementById("answerPanel");
  document.getElementById("answerQuestion").textContent = question;
  document.getElementById("answerText").innerHTML = "";
  document.getElementById("answerSources").innerHTML = "";
  document.getElementById("answerSourcesWrap").hidden = true;
  document.getElementById("answerMeta").textContent = "";
  panel.classList.add("open");
  document.body.classList.add("answer-open");
}

function closeAnswerPanel() {
  if (askController) askController.abort();
  document.getElementById("answerPanel").classList.remove("open");
  document.body.classList.remove("answer-open");
  clearAskHighlights();
}

async function askGraph(question) {
  const nodes = graphNodes().map((d) => ({ name: d.name, title: titleFromNode(d) }));
  if (!question || !nodes.length) return;

  if (askController) askController.abort();
  askController = new AbortController();
  clearAskHighlights();
  openAnswerPanel(question);
  setStatus("Sending the question");
  const button = document.getElementById("askSubmit");
  button.disabled = true;

  try {
    // a visitor who connected their own OpenRouter account on /q pays for
    // their own questions here too
    const headers = { "Content-Type": "application/json" };
    try {
      const k = localStorage.getItem("sa-or-key");
      if (k) headers["X-OpenRouter-Key"] = k;
    } catch (e) {}
    const resp = await fetch("/ask", {
      method: "POST",
      headers,
      body: JSON.stringify({ question, nodes }),
      signal: askController.signal,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      if (err.need_key) {
        throw new Error(err.error + " Connect it on sematlas.com/q, from the account button.");
      }
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleAskEvent(JSON.parse(line));
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") setStatus("Could not answer: " + e.message);
  } finally {
    button.disabled = false;
  }
}

function handleAskEvent(ev) {
  switch (ev.type) {
    case "status":
      setStatus(ev.message);
      break;
    case "scores": {
      applyScores(ev.scores);
      const n = Object.keys(ev.scores).length;
      const hi = Object.values(ev.scores).filter((p) => p >= REL_HIGH).length;
      const who = ev.scorer === "jev" ? "Jev" : `${ev.scorer} (Jev not available)`;
      document.getElementById("answerMeta").textContent =
        `${hi} of ${n} articles scored as strong evidence · scored by ${who}`;
      break;
    }
    case "sources":
      markSources(ev.names);
      break;
    case "text":
      setStatus("");
      appendText(ev.text);
      break;
    case "cite":
      appendCites(ev.cites);
      break;
    case "done":
      setStatus("");
      break;
    case "error":
      setStatus(ev.message);
      break;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("askForm");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      askGraph(document.getElementById("askInput").value.trim());
    });
  }
  // a new topic means a new graph; old scores no longer describe it
  const search = document.getElementById("searchbar");
  if (search) search.addEventListener("submit", () => closeAnswerPanel());
});
