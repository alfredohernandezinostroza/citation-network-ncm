// Interactive citation graph viewer (v2 + v1 features).
// Loads pre-built static assets in web/data/ and renders them with sigma.js.
// Adds: v1-like global filters (button/enter apply) + Tabulator table view,
// without slowing down rendering (keeps nodes-only base graph; edges only on selection).

import Graph from "https://cdn.jsdelivr.net/npm/graphology@0.25.4/+esm";
import { Sigma } from "https://cdn.jsdelivr.net/npm/sigma@2.4.0/+esm";

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  nodesData: null, // { year_min, year_max, nodes: [...] }
  clustersData: null, // { "0": {...}, ... }
  outCSR: null, // { offsets, targets }
  inCSR: null,
  abstracts: null, // lazy-loaded map: { nodeId: abstract }
  abstractsPromise: null,

  graph: null,
  renderer: null,

  selectedNode: null, // string id (= dense index as string)
  neighborSet: new Set(),
  hoveredNode: null,

  yearMin: 0,
  yearMax: 9999,

  mutedClusters: new Set(),
  colorBy: "cluster",
  highlightBridges: false,
  shiftDown: false,

  // v1-like filtering additions:
  filteredSet: null, // Set<string> of visible dense ids
  filters: {
    title: "",
    author: "",
    abstract: "",
    journal: "",
    keywords: "",
    mesh: "",
  },
  index: null, // precomputed lowercased fields per node

  // Tabulator
  table: null,

  // debouncer for refiltering on legend actions
  _refilterTimer: null,
};

// ── Boot ──────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error(err);
  const el = document.getElementById("loading");
  if (el) el.textContent = "Failed to load: " + err.message;
});

async function main() {
  const [nodesPayload, clustersPayload, outBuf, inBuf] = await Promise.all([
    fetch("data/nodes.json").then((r) => r.json()),
    fetch("data/clusters.json").then((r) => r.json()),
    fetch("data/edges_out.bin").then((r) => r.arrayBuffer()),
    fetch("data/edges_in.bin").then((r) => r.arrayBuffer()),
  ]);

  state.nodesData = nodesPayload;
  state.clustersData = clustersPayload;
  state.outCSR = parseCSR(outBuf);
  state.inCSR = parseCSR(inBuf);
  state.yearMin = nodesPayload.year_min;
  state.yearMax = nodesPayload.year_max;

  buildIndex();
  buildGraph();
  initSigma();
  initClusterLabels();
  initHover();
  initSelection();
  initShiftTracking();
  initControls();
  initTabs();
  initGlobalFilters();

  // initial "selected count" is all nodes
  updateSelectedCount();

  // Keep v2 behavior: year sliders apply live to rendering.
  // v1 behavior: other filters apply on button.
  // We keep both: year changes are live in reducer, and Filter button also
  // recomputes filteredSet (and table) using current year state.
  initYearControls();

  document.getElementById("loading")?.classList.add("hidden");
}

// ── CSR helpers ───────────────────────────────────────────────────────────
function parseCSR(buf) {
  const headerView = new DataView(buf, 0, 4);
  const n = headerView.getUint32(0, true);
  const offsets = new Uint32Array(buf, 4, n + 1);
  const totalEdges = offsets[n];
  const targets = new Uint32Array(buf, 4 + (n + 1) * 4, totalEdges);
  return { n, offsets, targets };
}
function csrNeighbors(csr, idx) {
  return csr.targets.subarray(csr.offsets[idx], csr.offsets[idx + 1]);
}

// ── Index build (fast filtering) ──────────────────────────────────────────
function buildIndex() {
  const nodes = state.nodesData.nodes;
  const title = new Array(nodes.length);
  const authors = new Array(nodes.length);
  const journal = new Array(nodes.length);
  const doi = new Array(nodes.length);
  const keywords = new Array(nodes.length);
  const mesh = new Array(nodes.length);

  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i];
    title[i] = (r.title || "").toLowerCase();
    authors[i] = (r.authors || "").toLowerCase(); // pipe-separated string
    journal[i] = (r.journal || "").toLowerCase();
    doi[i] = (r.doi || "").toLowerCase();
    // Not present yet in your current nodes.json; assumed same structure as authors once added:
    keywords[i] = (r.keywords || "").toLowerCase();
    mesh[i] = (r.mesh || "").toLowerCase();
  }

  state.index = { title, authors, journal, doi, keywords, mesh };
}

// ── Graph build ───────────────────────────────────────────────────────────
function nodeRenderSize(rec) {
  const s = (rec.size || 1) * 0.55;
  return Math.max(0.6, Math.min(8, s));
}

function buildGraph() {
  state.graph = new Graph({ type: "directed", multi: false });
  const nodes = state.nodesData.nodes;

  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i];
    const size = nodeRenderSize(r);
    state.graph.addNode(String(i), {
      x: r.x,
      y: r.y,
      size,
      color: r.color,
      label: "",
      _data: r,
      _baseSize: size,
      _baseColor: r.color,
    });
  }
}

// ── Sigma setup ───────────────────────────────────────────────────────────
function initSigma() {
  const container = document.getElementById("sigma-container");
  state.renderer = new Sigma(state.graph, container, {
    allowInvalidContainer: true,
    renderEdgeLabels: false,
    enableEdgeEvents: false,
    defaultEdgeColor: "#5a667a",
    labelDensity: 0.02,
    labelGridCellSize: 120,
    labelRenderedSizeThreshold: 14,
    labelColor: { color: "#e6e9ef" },
    labelFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    minCameraRatio: 0.03,
    maxCameraRatio: 30,
    nodeReducer,
    edgeReducer,
  });
}

function nodeReducer(node, attrs) {
  const a = Object.assign({}, attrs);
  const r = a._data;

  // v1-like global filtered set (fast membership check)
  if (state.filteredSet && !state.filteredSet.has(node)) {
    a.hidden = true;
    return a;
  }

  // year filter (live)
  if (r.year != null && (r.year < state.yearMin || r.year > state.yearMax)) {
    a.hidden = true;
    return a;
  }

  // cluster mute (live)
  if (state.mutedClusters.has(r.cluster)) {
    a.hidden = true;
    return a;
  }

  // color-by mode
  if (state.colorBy === "year" && r.year != null) {
    a.color = yearColor(r.year);
  } else if (state.colorBy === "indegree") {
    a.color = degreeColor(r.indegree || 0);
  }

  // bridge highlight
  if (state.highlightBridges && r.bridge) {
    a.color = "#ffd76e";
    a.size = a._baseSize * 1.6;
    a.zIndex = 3;
  }

  // selection dimming
  if (state.selectedNode !== null) {
    if (node === state.selectedNode) {
      a.size = a._baseSize * 1.6;
      a.zIndex = 4;
      a.label = r.title;
    } else if (state.neighborSet.has(node)) {
      a.zIndex = 3;
    } else {
      a.color = "#2a3140";
      a.size = a._baseSize * 0.5;
      a.zIndex = 0;
      a.label = "";
    }
  }

  // hover halo
  if (state.hoveredNode === node) {
    a.size = a._baseSize * 1.4;
    a.zIndex = 5;
  }

  return a;
}

function edgeReducer(edge, attrs) {
  return attrs;
}

// ── Color modes ───────────────────────────────────────────────────────────
const YEAR_RAMP = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

function yearColor(year) {
  const t =
    (year - state.nodesData.year_min) /
    Math.max(1, state.nodesData.year_max - state.nodesData.year_min);
  return rampColor(YEAR_RAMP, clamp01(t));
}

function degreeColor(d) {
  const t = Math.log10(d + 1) / Math.log10(1000);
  return rampColor(YEAR_RAMP, clamp01(t));
}

function rampColor(ramp, t) {
  const x = t * (ramp.length - 1);
  const i = Math.floor(x);
  const frac = x - i;
  const a = ramp[i];
  const b = ramp[Math.min(i + 1, ramp.length - 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * frac);
  const g = Math.round(a[1] + (b[1] - a[1]) * frac);
  const bl = Math.round(a[2] + (b[2] - a[2]) * frac);
  return `rgb(${r},${g},${bl})`;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// ── Cluster centroid labels ───────────────────────────────────────────────
function initClusterLabels() {
  const container = document.getElementById("cluster-labels");
  const labels = {};

  for (const cid of Object.keys(state.clustersData)) {
    const c = state.clustersData[cid];
    const el = document.createElement("div");
    el.className = "cluster-label";
    el.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${escapeHtml(
      c.name
    )}`;
    el.addEventListener("mouseenter", (e) => {
      if (e.shiftKey || state.shiftDown) showClusterDetail(cid);
    });
    el.addEventListener("click", (e) => {
      showClusterDetail(cid);
      e.stopPropagation();
    });
    container.appendChild(el);
    labels[cid] = el;
  }

  function reposition() {
    for (const cid of Object.keys(labels)) {
      const c = state.clustersData[cid];
      const pt = state.renderer.graphToViewport({
        x: c.centroid[0],
        y: c.centroid[1],
      });
      labels[cid].style.transform = `translate(-50%, -50%) translate(${pt.x}px, ${pt.y}px)`;
    }
  }
  state.renderer.on("afterRender", reposition);
  reposition();
}

// ── Hover tooltip ─────────────────────────────────────────────────────────
function initHover() {
  const tt = document.getElementById("tooltip");
  const container = document.getElementById("sigma-container");

  state.renderer.on("enterNode", ({ node }) => {
    state.hoveredNode = node;
    const r = state.graph.getNodeAttribute(node, "_data");
    const auths = (r.authors || "").split("|");
    const shown = auths.slice(0, 3).join(", ");
    const more = auths.length > 3 ? " et al." : "";
    tt.innerHTML =
      `<strong>${escapeHtml(r.title)}</strong>` +
      `<div class="tt-meta">${r.year ?? ""}${
        r.year ? " &middot; " : ""
      }${escapeHtml(shown)}${more}</div>`;
    tt.hidden = false;
    state.renderer.refresh();
  });

  state.renderer.on("leaveNode", () => {
    state.hoveredNode = null;
    tt.hidden = true;
    state.renderer.refresh();
  });

  container.addEventListener("mousemove", (e) => {
    if (tt.hidden) return;
    const pad = 14;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const r = tt.getBoundingClientRect();
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
    tt.style.left = x + "px";
    tt.style.top = y + "px";
  });
}

// ── Selection (click → draw incident edges + open detail) ────────────────
function initSelection() {
  state.renderer.on("clickNode", ({ node }) => {
    selectNode(parseInt(node, 10));
  });
  state.renderer.on("clickStage", () => {
    clearSelection();
    hideDetail();
  });
}

function selectNode(idx) {
  clearSelectionEdges();
  state.selectedNode = String(idx);
  const nset = new Set();
  nset.add(state.selectedNode);

  const outs = csrNeighbors(state.outCSR, idx);
  const ins = csrNeighbors(state.inCSR, idx);

  for (const t of outs) {
    const tid = String(t);
    nset.add(tid);
    const k = `__sel:${idx}->${t}`;
    if (!state.graph.hasEdge(k)) {
      state.graph.addDirectedEdgeWithKey(k, String(idx), tid, {
        color: "rgba(78,161,255,0.55)",
        size: 0.7,
      });
    }
  }
  for (const s of ins) {
    const sid = String(s);
    nset.add(sid);
    const k = `__sel:${s}->${idx}`;
    if (!state.graph.hasEdge(k)) {
      state.graph.addDirectedEdgeWithKey(k, sid, String(idx), {
        color: "rgba(255,158,78,0.45)",
        size: 0.6,
      });
    }
  }
  state.neighborSet = nset;
  state.renderer.refresh();
  showPaperDetail(idx);
}

function clearSelectionEdges() {
  const toRemove = [];
  state.graph.forEachEdge((edge) => {
    if (edge.startsWith("__sel:")) toRemove.push(edge);
  });
  for (const e of toRemove) state.graph.dropEdge(e);
}

function clearSelection() {
  clearSelectionEdges();
  state.selectedNode = null;
  state.neighborSet = new Set();
  state.renderer.refresh();
}

// ── Detail panel ──────────────────────────────────────────────────────────
function showPaperDetail(idx) {
  const r = state.nodesData.nodes[idx];
  const cluster = state.clustersData[String(r.cluster)];
  const auths = (r.authors || "").split("|").join(", ");
  const doiHtml = r.doi
    ? `<a href="https://doi.org/${encodeURIComponent(
        r.doi
      )}" target="_blank" rel="noopener">Open DOI</a>`
    : "";
  const clusterTag = cluster
    ? `<span class="cluster-tag" style="background:${cluster.color};color:#0e1116">${escapeHtml(
        cluster.name
      )}</span>`
    : "";
  const bridgeBadge = r.bridge
    ? `<span class="cluster-tag" style="background:#ffd76e;color:#0e1116">Bridge paper</span>`
    : "";

  const numOut = state.outCSR.offsets[idx + 1] - state.outCSR.offsets[idx];
  const numIn = state.inCSR.offsets[idx + 1] - state.inCSR.offsets[idx];

  document.getElementById("detail-body").innerHTML = `
    ${clusterTag} ${bridgeBadge}
    <h2>${escapeHtml(r.title)}</h2>
    <div class="meta">${escapeHtml(auths)}</div>
    <div class="meta">${r.year ?? ""}${
    r.journal ? " &middot; " + escapeHtml(r.journal) : ""
  }</div>
    <div class="meta">${r.indegree || 0} citations &middot; cites ${numOut} &middot; cited by ${numIn}</div>
    <div class="actions">
      ${doiHtml}
      <button id="frame-node">Center on paper</button>
    </div>
    <h3>Abstract</h3>
    <div class="abstract" id="abstract-slot">Loading...</div>
  `;
  document.getElementById("detail").hidden = false;
  document.getElementById("frame-node").addEventListener("click", () => frameNode(idx));

  loadAbstract(r.id).then((abs) => {
    const slot = document.getElementById("abstract-slot");
    if (slot) slot.textContent = abs || "(no abstract on file)";
  });
}

function showClusterDetail(cid) {
  const c = state.clustersData[cid];
  if (!c) return;
  const papers = (c.top_papers || [])
    .map(
      (p) =>
        `<li>${escapeHtml(p.title)}<div class="sub">${p.year ?? ""}${
          p.in_degree ? " &middot; " + p.in_degree + " citations" : ""
        }</div></li>`
    )
    .join("");
  const authors = (c.top_authors || [])
    .map(
      (a) => `<li>${escapeHtml(a.name)}<div class="sub">${a.papers ?? ""} papers</div></li>`
    )
    .join("");
  const keywords = (c.top_keywords || [])
    .map(
      (k) =>
        `<li>${escapeHtml(k.keyword)}<div class="sub">tf-idf ${
          k.tfidf?.toFixed(3) ?? ""
        }</div></li>`
    )
    .join("");

  document.getElementById("detail-body").innerHTML = `
    <span class="cluster-tag" style="background:${c.color};color:#0e1116">${escapeHtml(
    c.name
  )}</span>
    <h2>${escapeHtml(c.name)}</h2>
    <div class="meta">${c.size.toLocaleString()} papers in this community</div>
    <div class="actions">
      <button id="isolate-cluster">Isolate this community</button>
      <button id="frame-cluster">Center view</button>
    </div>
    <h3>Top keywords</h3><ul class="top-list">${keywords}</ul>
    <h3>Top authors</h3><ul class="top-list">${authors}</ul>
    <h3>Top papers</h3><ul class="top-list">${papers}</ul>
  `;
  document.getElementById("detail").hidden = false;
  document.getElementById("frame-cluster").addEventListener("click", () => frameCluster(cid));
  document
    .getElementById("isolate-cluster")
    .addEventListener("click", () => isolateCluster(cid));
}

function hideDetail() {
  document.getElementById("detail").hidden = true;
}

// ── Camera helpers ────────────────────────────────────────────────────────
function frameNode(idx) {
  const display = state.renderer.getNodeDisplayData(String(idx));
  if (!display) return;
  state.renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.15 }, { duration: 600 });
}

function frameCluster(cid) {
  const c = state.clustersData[cid];
  let bestIdx = -1;
  let bestDist = Infinity;
  const cx = c.centroid[0],
    cy = c.centroid[1];
  for (let i = 0; i < state.nodesData.nodes.length; i++) {
    const n = state.nodesData.nodes[i];
    if (n.cluster !== c.id) continue;
    const dx = n.x - cx,
      dy = n.y - cy;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) frameNode(bestIdx);
}

// ── Cluster isolate / legend ──────────────────────────────────────────────
function isolateCluster(cid) {
  const target = parseInt(cid, 10);
  state.mutedClusters = new Set();
  for (const k of Object.keys(state.clustersData)) {
    const id = parseInt(k, 10);
    if (id !== target) state.mutedClusters.add(id);
  }
  for (const r of state.nodesData.nodes) {
    if (r.cluster !== target) state.mutedClusters.add(r.cluster);
  }
  refreshLegend();
  state.renderer.refresh();
  scheduleRefilter();
}

// ── Controls ──────────────────────────────────────────────────────────────
function initControls() {
  // Color-by
  document.getElementById("color-by").addEventListener("change", (e) => {
    state.colorBy = e.target.value;
    state.renderer.refresh();
  });

  // Bridge highlight
  document.getElementById("bridge-toggle").addEventListener("change", (e) => {
    state.highlightBridges = e.target.checked;
    state.renderer.refresh();
  });

  // Detail close
  document.getElementById("detail-close").addEventListener("click", () => {
    hideDetail();
    clearSelection();
  });

  // Legend
  buildLegend();

  //Search bar
  initSearch();

  //Hide button
  initControlsToggle()
}
function initSearch() {
  const input = document.getElementById("search");
  const list = document.getElementById("search-results");
  if (!input || !list) return;

  let timer = null;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value), 120);
  });

  function runSearch(q) {
    q = q.trim().toLowerCase();
    if (q.length < 3) {
      list.hidden = true;
      list.innerHTML = "";
      return;
    }

    const hits = [];
    const nodes = state.nodesData.nodes;
    const idx = state.index;

    for (let i = 0; i < nodes.length && hits.length < 25; i++) {
      // Use precomputed lowercase strings (fast, no allocations)
      if (
        idx.title[i].includes(q) ||
        idx.authors[i].includes(q) ||
        idx.doi[i].includes(q)
      ) {
        hits.push(i);
      }
    }

    list.innerHTML = hits
      .map((i) => {
        const r = nodes[i];
        const firstAuthor = ((r.authors || "").split("|")[0] || "");
        return `<li data-idx="${i}">${escapeHtml(r.title)}<div class="meta">${r.year ?? ""} &middot; ${escapeHtml(firstAuthor)}</div></li>`;
      })
      .join("");

    list.hidden = hits.length === 0;

    for (const li of list.children) {
      li.addEventListener("click", () => {
        const idx = parseInt(li.dataset.idx, 10);
        selectNode(idx);
        frameNode(idx);
        list.hidden = true;
        list.innerHTML = "";
        input.value = "";
      });
    }
  }

  // Close results on escape / blur
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      list.hidden = true;
      list.innerHTML = "";
      input.value = "";
    }
  });
  input.addEventListener("blur", () => {
    // small delay so click can register
    setTimeout(() => {
      list.hidden = true;
    }, 150);
  });
}

function initYearControls() {
  const ymin = document.getElementById("year-min");
  const ymax = document.getElementById("year-max");
  const readout = document.getElementById("year-readout");

  ymin.min = ymax.min = state.nodesData.year_min;
  ymin.max = ymax.max = state.nodesData.year_max;
  ymin.value = state.nodesData.year_min;
  ymax.value = state.nodesData.year_max;

  function updateYear() {
    let lo = parseInt(ymin.value, 10);
    let hi = parseInt(ymax.value, 10);
    if (lo > hi) [lo, hi] = [hi, lo];
    state.yearMin = lo;
    state.yearMax = hi;
    readout.textContent = `${lo}–${hi}`;

    // Live renderer update stays fast (reducer only)
    state.renderer.refresh();

    // Keep table + count consistent with global filter selection if already active
    // (schedule to avoid heavy work during slider drag)
    scheduleRefilter();
  }

  ymin.addEventListener("input", updateYear);
  ymax.addEventListener("input", updateYear);
  updateYear();
}

function buildLegend() {
  const ul = document.getElementById("legend");
  ul.innerHTML = "";
  const ids = Object.keys(state.clustersData).sort(
    (a, b) => state.clustersData[b].size - state.clustersData[a].size
  );
  for (const cid of ids) {
    const c = state.clustersData[cid];
    const li = document.createElement("li");
    li.dataset.cid = cid;
    li.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${escapeHtml(
      c.name
    )} <span style="margin-left:auto;color:var(--text-dim)">${c.size}</span>`;
    li.style.display = "flex";
    li.addEventListener("click", () => {
      const id = parseInt(cid, 10);
      if (state.mutedClusters.has(id)) state.mutedClusters.delete(id);
      else state.mutedClusters.add(id);
      refreshLegend();
      state.renderer.refresh();
      scheduleRefilter();
    });
    li.addEventListener("dblclick", () => {
      state.mutedClusters = new Set();
      refreshLegend();
      state.renderer.refresh();
      scheduleRefilter();
    });
    ul.appendChild(li);
  }
  refreshLegend();
}

function refreshLegend() {
  const ul = document.getElementById("legend");
  for (const li of ul.children) {
    const id = parseInt(li.dataset.cid, 10);
    li.classList.toggle("muted", state.mutedClusters.has(id));
  }
}

// ── Tabs (Graph/Table) ───────────────────────────────────────────────────
function initTabs() {
  const tabGraph = document.getElementById("tab-graph");
  // const tabTable = document.getElementById("tab-table");
  const viewGraph = document.getElementById("view-graph");
  // const viewTable = document.getElementById("view-table");

  tabGraph.addEventListener("click", () => {
    tabGraph.classList.add("active");
    // tabTable.classList.remove("active");
    viewGraph.classList.add("active");
    // viewTable.classList.remove("active");
    state.renderer.refresh();
  });

  // tabTable.addEventListener("click", () => {
  //   tabTable.classList.add("active");
  //   tabGraph.classList.remove("active");
  //   viewTable.classList.add("active");
  //   viewGraph.classList.remove("active");

  //   if (!state.table) initTable();
  //   setTimeout(() => state.table && state.table.redraw(true), 0);
  // });
}

function initControlsToggle() {
  const panel = document.getElementById("controls");
  const btn = document.getElementById("controls-toggle");
  if (!panel || !btn) return;

  btn.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    btn.textContent = collapsed ? "⟩" : "⟨";
    btn.setAttribute("aria-label", collapsed ? "Show controls" : "Hide controls");

    // sigma needs a refresh after large overlay changes
    if (state.renderer) state.renderer.refresh();
  });
}
// ── Global filters (v1-like) ─────────────────────────────────────────────
function initGlobalFilters() {
  const elTitle = document.getElementById("filter-title");
  const elAuthor = document.getElementById("filter-author");
  const elAbstract = document.getElementById("filter-abstract");
  const elJournal = document.getElementById("filter-journal");
  const elKeywords = document.getElementById("filter-keywords");
  // const elMesh = document.getElementById("filter-mesh");
  const btn = document.getElementById("apply-filters");

  function readFiltersFromUI() {
    state.filters.title = elTitle?.value || "";
    state.filters.author = elAuthor?.value || "";
    state.filters.abstract = elAbstract?.value || "";
    state.filters.journal = elJournal?.value || "";
    state.filters.keywords = elKeywords?.value || "";
    // state.filters.mesh = elMesh?.value || "";
  }

  async function run() {
    btn.disabled = true;
    const oldTxt = btn.textContent;
    btn.textContent = "Filtering...";
    try {
      readFiltersFromUI();
      await applyGlobalFilters();
    } finally {
      btn.disabled = false;
      btn.textContent = oldTxt;
    }
  }

  btn.addEventListener("click", run);

  // const inputs = [elTitle, elAuthor, elAbstract, elJournal, elKeywords, elMesh].filter(Boolean);
  const inputs = [elTitle, elAuthor, elAbstract, elJournal, elKeywords].filter(Boolean);
  for (const input of inputs) {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      run();
    });
  }
}

function splitCommaQueries(s) {
  return s
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// "AND" semantics for comma-separated: all queries must match the pipe-string somewhere.
function matchesAll(pipeLc, queries) {
  for (const q of queries) {
    if (!pipeLc.includes(q)) return false;
  }
  return true;
}

async function ensureAbstractsLoadedIfNeeded() {
  // You asked: "Enable abstract filtering by default".
  // To keep performance reasonable, we only load abstracts when we actually apply filters
  // (and only if abstract field is used OR you want always loaded).
  //
  // If you *really* want always loaded on every filter apply even when query empty,
  // change condition to `if (!state.abstracts) await loadAbstract("n2");`
  if (state.filters.abstract.trim() && !state.abstracts) {
    await loadAbstract("n2"); // triggers lazy load
  }
}

async function applyGlobalFilters() {
  await ensureAbstractsLoadedIfNeeded();

  const f = state.filters;
  const qTitle = f.title.trim().toLowerCase();
  const qJournal = f.journal.trim().toLowerCase();
  const qAbstract = f.abstract.trim().toLowerCase();
  const authorQs = splitCommaQueries(f.author);
  const keywordQs = splitCommaQueries(f.keywords);
  const meshQs = splitCommaQueries(f.mesh);

  const lo = state.yearMin;
  const hi = state.yearMax;

  const idx = state.index;
  const nodes = state.nodesData.nodes;

  const out = new Set();

  for (let i = 0; i < nodes.length; i++) {
    const r = nodes[i];

    // Include same constraints as on-screen reducer so count/table match the graph
    if (r.year != null && (r.year < lo || r.year > hi)) continue;
    if (state.mutedClusters.has(r.cluster)) continue;

    if (qTitle && !idx.title[i].includes(qTitle)) continue;
    if (qJournal && !idx.journal[i].includes(qJournal)) continue;

    if (authorQs.length && !matchesAll(idx.authors[i], authorQs)) continue;
    if (keywordQs.length && !matchesAll(idx.keywords[i], keywordQs)) continue;
    if (meshQs.length && !matchesAll(idx.mesh[i], meshQs)) continue;

    if (qAbstract) {
      const abs = (state.abstracts?.[r.id] || "").toLowerCase();
      if (!abs.includes(qAbstract)) continue;
    }

    out.add(String(i));
  }

  // If no filters are set at all (except year/mute), we still set filteredSet so
  // table/count are consistent. This is cheap: it's just a Set of visible nodes.
  state.filteredSet = out;

  updateSelectedCount();
  state.renderer.refresh();

  if (state.table) replaceTableDataFromFiltered();
}

function scheduleRefilter() {
  // Refilter only if user already applied filters at least once or if table is open.
  // Otherwise keep it cheap: just update graph via reducer refresh.
  clearTimeout(state._refilterTimer);
  state._refilterTimer = setTimeout(() => {
    if (state.filteredSet || state.table) applyGlobalFilters();
    else updateSelectedCount();
  }, 90);
}

function updateSelectedCount() {
  const el = document.getElementById("selected-count");
  if (!el) return;

  // If we haven't applied global filters yet, "selected" means nodes visible
  // under year + muted cluster constraints (live reducer). Compute cheaply.
  if (!state.filteredSet) {
    let c = 0;
    const nodes = state.nodesData.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i];
      if (r.year != null && (r.year < state.yearMin || r.year > state.yearMax)) continue;
      if (state.mutedClusters.has(r.cluster)) continue;
      c++;
    }
    el.textContent = `Nodes selected: ${c.toLocaleString()}`;
    return;
  }

  el.textContent = `Nodes selected: ${state.filteredSet.size.toLocaleString()}`;
}

// ── Table (Tabulator) ────────────────────────────────────────────────────
function initTable() {
  // Tabulator is loaded globally via <script> in index.html
  // eslint-disable-next-line no-undef
  state.table = new Tabulator("#papers-table", {
    data: [],
    layout: "fitColumns",
    pagination: "local",
    paginationSize: 10,
    paginationSizeSelector: [5, 10, 20, 50, 100],
    columns: [
      { title: "Paper", field: "title", widthGrow: 3 },
      { title: "Authors", field: "authors", widthGrow: 2 },
      { title: "Citations", field: "indegree", sorter: "number", widthGrow: 1 },
      { title: "Year", field: "year", sorter: "number", widthGrow: 1 },
      { title: "Journal", field: "journal", widthGrow: 2 },
      {
        title: "Link",
        field: "doi",
        formatter: (cell) => {
          const doi = cell.getValue();
          if (!doi) return "";
          const url = `https://doi.org/${encodeURIComponent(doi)}`;
          return `<a href="${url}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
        },
        widthGrow: 2,
      },
      { title: "Doi", field: "doi", widthGrow: 2 },
    ],
    initialSort: [{ column: "indegree", dir: "desc" }],
    rowClick: (_e, row) => {
      const data = row.getData();
      if (data && typeof data._idx === "number") {
        selectNode(data._idx);
        frameNode(data._idx);
      }
    },
  });

  const field = document.getElementById("table-filter-field");
  const type = document.getElementById("table-filter-type");
  const value = document.getElementById("table-filter-value");
  const clear = document.getElementById("table-filter-clear");

  function applyTableFilter() {
    const f = field.value;
    const t = type.value;
    const v = value.value;
    if (!f) return;
    state.table.setFilter(f, t, v);
  }

  field.addEventListener("change", applyTableFilter);
  type.addEventListener("change", applyTableFilter);
  value.addEventListener("keyup", applyTableFilter);

  clear.addEventListener("click", () => {
    field.value = "";
    type.value = "like";
    value.value = "";
    state.table.clearFilter();
  });

  replaceTableDataFromFiltered();
}

function replaceTableDataFromFiltered() {
  const nodes = state.nodesData.nodes;

  // If filters never applied, table shows visible nodes under year+mutes.
  let ids;
  if (state.filteredSet) {
    ids = Array.from(state.filteredSet);
  } else {
    ids = [];
    for (let i = 0; i < nodes.length; i++) {
      const r = nodes[i];
      if (r.year != null && (r.year < state.yearMin || r.year > state.yearMax)) continue;
      if (state.mutedClusters.has(r.cluster)) continue;
      ids.push(String(i));
    }
  }

  const data = new Array(ids.length);
  for (let k = 0; k < ids.length; k++) {
    const i = parseInt(ids[k], 10);
    const r = nodes[i];
    data[k] = {
      _idx: i,
      id: r.id,
      title: r.title || "",
      authors: (r.authors || "").split("|").join(", "),
      year: r.year ?? "",
      journal: r.journal || "",
      doi: r.doi || "",
      indegree: r.indegree || 0,
    };
  }
  state.table.replaceData(data);
}

// ── Shift key tracking (for cluster shift+hover) ─────────────────────────
function initShiftTracking() {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") state.shiftDown = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") state.shiftDown = false;
  });
}

// ── Lazy-loaded abstracts ────────────────────────────────────────────────
function loadAbstract(nodeId) {
  if (state.abstracts) return Promise.resolve(state.abstracts[nodeId] || "");
  if (!state.abstractsPromise) {
    state.abstractsPromise = fetch("data/abstracts.json")
      .then((r) => r.json())
      .then((obj) => {
        state.abstracts = obj;
        return obj;
      });
  }
  return state.abstractsPromise.then((obj) => obj[nodeId] || "");
}

// ── Utils ─────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}