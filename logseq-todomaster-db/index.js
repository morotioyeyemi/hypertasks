/**
 * TODO Master (DB) — progress-bar renderer for Logseq DB graphs
 * =============================================================
 * Drop-in replacement for the `{{renderer :todomaster}}` progress bar that the
 * original logseq-plugin-todo-master draws. That plugin reads `block.marker`,
 * which is always empty on DB-version graphs, so its bars are stuck at 0%.
 *
 * This version resolves task state from `:logseq.property/status` (idents like
 * :logseq.property/status.done / .doing / .todo ...) and counts every task in
 * the subtree of the block that hosts the macro (or every task on a page for
 * the `:todomaster-<page>` variant).
 *
 * Supported macros:
 *   {{renderer :todomaster}}            -> progress of the hosting block's subtree
 *   {{renderer :todomaster-<pagename>}} -> progress of all tasks on <pagename>
 */

'use strict';

const MACRO = ':todomaster';

// ---------------------------------------------------------------------------
// Query helper with a per-rerender-cycle cache.
// A single tracker page can host several bars; without caching each bar would
// re-pull the entire page independently. `cachedQuery` de-dupes identical
// queries within one render pass. `resetQueryCache()` is called at the start of
// every pass so results never go stale across edits.
// ---------------------------------------------------------------------------
let _queryCache = new Map();      // q -> { t, p }
const QUERY_TTL_MS = 500;
function resetQueryCache() { _queryCache = new Map(); }
async function cachedQuery(q) {
  const hit = _queryCache.get(q);
  if (hit && (Date.now() - hit.t) < QUERY_TTL_MS) return hit.p;
  const p = logseq.DB.datascriptQuery(q);
  _queryCache.set(q, { t: Date.now(), p });
  return p;
}

// ---------------------------------------------------------------------------
// pull-result helpers (keys may be "block/uuid" or ":block/uuid")
// ---------------------------------------------------------------------------
function pick(obj, key) {
  if (obj == null) return undefined;
  if (obj[key] !== undefined) return obj[key];
  if (obj[':' + key] !== undefined) return obj[':' + key];
  return undefined;
}

function uuidOf(entity) {
  let u = pick(entity, 'block/uuid') ?? (entity && entity.uuid);
  if (u == null) return null;
  if (typeof u === 'object') u = u.uuid || u['$uuid'] || String(u);
  return String(u);
}

/** Return a normalized status bucket from a status ident string. */
function identToBucket(id) {
  if (id == null) return null;
  id = String(id).toLowerCase();
  if (id.indexOf('cancel') >= 0) return 'canceled';
  if (id.indexOf('done') >= 0) return 'done';
  if (id.indexOf('doing') >= 0 || id.indexOf('review') >= 0 || id.indexOf('progress') >= 0) return 'doing';
  if (id.indexOf('todo') >= 0 || id.indexOf('backlog') >= 0 || id.indexOf('later') >= 0 || id.indexOf('wait') >= 0) return 'todo';
  return 'todo';
}

/** Return a normalized status bucket for a pulled block, or null if no status. */
function statusBucket(block) {
  const s = pick(block, 'logseq.property/status');
  if (s == null) return null;
  const id = pick(s, 'db/ident') ?? s.ident ?? s;
  return identToBucket(id);
}

/** Extract referenced block uuids from a block's title/content ([[uuid]] or ((uuid))). */
function extractRefUuids(title) {
  if (title == null) return [];
  const out = [];
  const re = /(?:\[\[|\(\()([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})(?:\]\]|\)\))/g;
  let m;
  while ((m = re.exec(String(title))) !== null) out.push(m[1]);
  return out;
}

/** Resolve status buckets for a set of block uuids (works across pages). */
async function resolveStatuses(uuids) {
  const map = new Map();
  if (!uuids.length) return map;
  const set = '#{' + uuids.map((u) => `"${String(u)}"`).join(' ') + '}';
  const q = `
    [:find ?us ?i
     :where
     [?b :block/uuid ?u] [(str ?u) ?us] [(contains? ${set} ?us)]
     [?b :logseq.property/status ?st] [?st :db/ident ?i]]`;
  const res = await cachedQuery(q);
  for (const row of res || []) {
    if (Array.isArray(row) && row.length >= 2) map.set(String(row[0]), identToBucket(row[1]));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Progress computation
// ---------------------------------------------------------------------------
function tally(buckets) {
  let done = 0, total = 0, doing = 0;
  for (const b of buckets) {
    if (!b || b === 'canceled') continue;
    total += 1;
    if (b === 'done') done += 1;
    else if (b === 'doing') doing += 1;
  }
  const pct = total ? Math.round((done / total) * 100) : 100;
  return { done, doing, total, pct };
}

/** Subtree of a block (by uuid): pull all blocks on its page + parent links,
 *  then walk descendants in JS. Blocks with their own status count directly;
 *  status-less blocks that reference tasks ([[uuid]] / ((uuid))) count those
 *  referenced tasks (this is how the journal "top picks" bar works). */
async function computeForBlock(rootUuid) {
  const root = String(rootUuid);
  // Cheap: find the page db-id for this root (keyed by root uuid).
  const pgRes = await cachedQuery(`
    [:find ?pg
     :where [?r :block/uuid ?ru] [(str ?ru) ?rs] [(= ?rs "${root}")]
     [?r :block/page ?pg]]`);
  const pageId = (pgRes && pgRes[0] && (Array.isArray(pgRes[0]) ? pgRes[0][0] : pgRes[0])) || null;
  if (pageId == null) return tally([]);

  // Heavy: pull every block on that page. Keyed only by page id, so all bars
  // hosted on the same page reuse ONE query result within a render pass.
  const q = `
    [:find (pull ?b [:block/uuid
                     :block/title
                     {:block/parent [:block/uuid]}
                     {:logseq.property/status [:db/ident]}])
     :where [?b :block/page ${pageId}]]`;
  const res = await cachedQuery(q);
  const rows = (res || []).map((r) => (Array.isArray(r) ? r[0] : r));

  const byUuid = new Map();
  const childrenByParent = new Map();
  for (const b of rows) {
    const id = uuidOf(b);
    if (!id) continue;
    byUuid.set(id, b);
    const p = pick(b, 'block/parent') ?? b.parent;
    const pid = p ? uuidOf(p) : null;
    if (pid) {
      if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
      childrenByParent.get(pid).push(id);
    }
  }

  // BFS descendants of root (exclude the root block itself).
  const descend = [];
  const stack = [...(childrenByParent.get(rootUuid) || [])];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const b = byUuid.get(id);
    if (b) descend.push(b);
    for (const c of childrenByParent.get(id) || []) stack.push(c);
  }

  // Direct statuses; collect references from status-less blocks.
  const buckets = [];
  const refList = [];
  for (const b of descend) {
    const own = statusBucket(b);
    if (own) { buckets.push(own); continue; }
    const refs = extractRefUuids(pick(b, 'block/title') ?? b.title);
    for (const r of refs) refList.push(r);
  }
  if (refList.length) {
    const map = await resolveStatuses([...new Set(refList)]);
    for (const r of refList) buckets.push(map.get(r) || null);
  }
  return tally(buckets);
}

/** All tasks on a named page. */
async function computeForPage(pageName) {
  const name = String(pageName).toLowerCase().replace(/"/g, '\\"');
  const q = `
    [:find (pull ?b [{:logseq.property/status [:db/ident]}])
     :where [?p :block/name "${name}"] [?b :block/page ?p]]`;
  const res = await cachedQuery(q);
  const rows = (res || []).map((r) => (Array.isArray(r) ? r[0] : r));
  return tally(rows.map(statusBucket));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function barTemplate(slot, p) {
  const width = 180;
  const fill = Math.max(0, Math.min(100, p.pct));
  const title = `${p.done} done / ${p.total} total` + (p.doing ? ` (${p.doing} in progress)` : '');
  return `
    <span class="tmdb" title="${title}">
      <span class="tmdb-track">
        <span class="tmdb-fill" style="width:${fill}%;"></span>
      </span>
      <span class="tmdb-label">${p.done}/${p.total} · ${p.pct}%</span>
    </span>`.replace(/\s*\n\s*/g, '');
}

async function renderSlot(slot, spec) {
  try {
    const p = spec.page ? await computeForPage(spec.page) : await computeForBlock(spec.root);
    const sig = `${p.done}/${p.total}/${p.doing}/${p.pct}`;
    if (spec.sig === sig) return; // unchanged: skip DOM churn
    spec.sig = sig;
    logseq.provideUI({
      key: 'tmdb__' + slot,
      slot,
      reset: true,
      template: barTemplate(slot, p),
    });
  } catch (e) {
    console.warn('[todomaster-db] render failed for', slot, e && e.message ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
const SLOTS = new Map(); // slot -> { root?:uuid, page?:name, sig?:string }
let rerenderTimer = null;

// Attributes whose changes can affect a progress bar. Everything else
// (cursor moves, collapse state, typing into task text, ui prefs, etc.)
// is ignored so we don't re-run expensive full-page queries on every click.
const RELEVANT_ATTR = /status|block\/parent|block\/refs|block\/page/;

function isRelevantChange(e) {
  const tx = e && e.txData;
  if (!Array.isArray(tx) || !tx.length) return false;
  let sawAttr = false;
  for (const d of tx) {
    // datom shape: [e, a, v, tx, added]; `a` may be a keyword string or ident.
    const a = Array.isArray(d) ? d[1] : (d && d.a);
    if (a == null) continue;
    sawAttr = true;
    if (RELEVANT_ATTR.test(String(a))) return true;
  }
  // If we couldn't read any attribute names, fall back to re-rendering so we
  // never silently miss a status toggle.
  return !sawAttr;
}

async function runRerender() {
  rerenderTimer = null;
  // Don't compete with active typing/indenting: if the user is editing, wait.
  try {
    if (await logseq.Editor.checkEditing()) {
      rerenderTimer = setTimeout(runRerender, 800);
      return;
    }
  } catch {}
  resetQueryCache();               // fresh data; shared across all slots this pass
  for (const [slot, spec] of SLOTS) await renderSlot(slot, spec);
}

function scheduleRerender(e) {
  if (!isRelevantChange(e)) return;
  if (rerenderTimer) clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(runRerender, 800);
}

function main() {
  console.info('[todomaster-db] loaded v6 (shared page-pull cache + edit-aware rerender)');

  logseq.provideStyle(`
    .tmdb { display:inline-flex; align-items:center; gap:6px; vertical-align:middle; }
    .tmdb-track { position:relative; display:inline-block; width:180px; height:10px;
      background: var(--ls-secondary-background-color, rgba(127,127,127,.25));
      border-radius: 5px; overflow:hidden; }
    .tmdb-fill { position:absolute; left:0; top:0; bottom:0;
      background: var(--ls-active-primary-color, #10b981); transition: width .2s ease; }
    .tmdb-label { font-size:.8em; opacity:.75; white-space:nowrap; }
  `);

  logseq.App.onMacroRendererSlotted(async ({ payload, slot }) => {
    const arg = (payload.arguments && payload.arguments[0]) || '';
    if (!arg.startsWith(MACRO)) return;

    let spec;
    if (arg === MACRO) {
      spec = { root: String(payload.uuid) };
    } else if (arg.startsWith(MACRO + '-')) {
      let page = arg.slice((MACRO + '-').length);
      try { page = decodeURIComponent(page); } catch {}
      spec = { page };
    } else {
      return;
    }
    SLOTS.set(slot, spec);
    await renderSlot(slot, spec);
  });

  // Re-render bars when tasks change (mark done, add/remove, etc.).
  logseq.DB.onChanged(scheduleRerender);

  // Slash command to insert a bar (same name as the original plugin).
  logseq.Editor.registerSlashCommand('[TODO Master] Add Progress Bar', async () => {
    await logseq.Editor.insertAtEditingCursor(`{{renderer ${MACRO}}}`);
  });
}

logseq.ready(main).catch(console.error);
