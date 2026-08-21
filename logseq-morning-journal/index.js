/**
 * Morning Journal — Logseq DB-graph plugin
 * ========================================
 * Reimplements the old file-based scripts/morning.py journal step for the
 * DB version of Logseq (which has no markdown files).
 *
 * On command it:
 *   1. Queries all open tracker tasks in the configured SCOPE (default "msft")
 *      on the TRACKER_PAGES. "Open" = has a status, excluding backlog, wait,
 *      done, and canceled. Deadlines are ignored.
 *   2. Sorts them by creation time (:block/created-at), oldest first.
 *   3. Creates/opens today's journal and inserts:
 *        - top picks {{renderer :todomaster}}
 *            - ((block-ref)) for each open task, oldest-created first
 *            - (empty)
 *            - [[completed]]
 *        - meetings
 *            - (empty)
 *        - journal
 *            - (empty)
 *
 * Trigger: command palette + hotkey (Ctrl/Cmd+Alt+M), or slash command
 * "Morning Journal".
 */

'use strict';

// ---------------------------------------------------------------------------
// CONFIG — adjust these if your graph uses different names.
// ---------------------------------------------------------------------------
const SCOPE_REF = 'msft';                   // keep only tasks under a tracker section that references [[msft]]; '' = keep all
const TRACKER_PAGES = ['tracker'];          // work tracker only (tracker2 is personal)
// Statuses to leave OUT of the morning list. Built-in statuses are matched by
// their :db/ident; custom statuses (e.g. WAIT) have no :db/ident and are
// matched by title (case-insensitive). Everything not excluded counts as open.
const EXCLUDE_STATUS_IDENTS = [
  'logseq.property/status.backlog',
  'logseq.property/status.done',
  'logseq.property/status.canceled',
];
const EXCLUDE_STATUS_TITLES = ['wait'];

// ---------------------------------------------------------------------------
// Helpers for reading pull-result maps (keys may be "block/uuid" or ":block/uuid")
// ---------------------------------------------------------------------------
function pick(obj, key) {
  if (obj == null) return undefined;
  if (obj[key] !== undefined) return obj[key];
  if (obj[':' + key] !== undefined) return obj[':' + key];
  return undefined;
}

function uuidOf(entity) {
  let u = pick(entity, 'block/uuid') ?? entity.uuid;
  if (u == null) return null;
  if (typeof u === 'object') u = u.uuid || u['$uuid'] || u.toString();
  return String(u);
}

function stripRenderer(title) {
  if (title == null) return '';
  return String(title).replace(/\s*\{\{renderer[^}]*\}\}/g, '').trim();
}

/** Block creation time is stored as a scalar epoch-millis. Return it as a
 *  number, or null if unavailable. (Pull results key this as short "created-at".) */
function createdAtMs(entity) {
  const ms = pick(entity, 'block/created-at') ?? entity['created-at'] ?? entity.createdAt;
  if (ms == null) return null;
  const n = Number(ms);
  return isNaN(n) ? null : n;
}

/** The status entity for a task, tolerating short/long result keys. */
function statusOf(entity) {
  return pick(entity, 'logseq.property/status') ?? entity.status ?? null;
}

/** True if the task's status is one we leave out of the morning list
 *  (backlog/done/canceled by :db/ident, wait by title), or it has no status.
 *  Pull results shorten keys, so :db/ident -> "ident", :block/title -> "title". */
function isExcludedStatus(entity) {
  const s = statusOf(entity);
  if (s == null) return true; // no status => not an open task
  let ident = pick(s, 'db/ident') ?? s.ident;
  if (ident != null) {
    ident = String(ident).replace(/^:/, '');
    if (EXCLUDE_STATUS_IDENTS.includes(ident)) return true;
  }
  const title = String(pick(s, 'block/title') ?? s.title ?? '').trim().toLowerCase();
  if (EXCLUDE_STATUS_TITLES.includes(title)) return true;
  return false;
}

/** Human-readable status title, for logging. */
function statusTitle(entity) {
  const s = statusOf(entity);
  return String((s && (pick(s, 'block/title') ?? s.title)) ?? '(none)');
}

/** Walk up the pulled :block/parent chain; return the ancestor block titles
 *  from top-level (closest to page) down. The page node has :block/name. */
function categoryPath(entity) {
  const titles = [];
  let node = pick(entity, 'block/parent') ?? entity.parent;
  while (node) {
    const name = pick(node, 'block/name') ?? node.name; // pages have :block/name
    if (name != null) break; // reached the page
    const title = stripRenderer(pick(node, 'block/title') ?? node.title);
    if (title) titles.unshift(title); // top-level ends up first
    node = pick(node, 'block/parent') ?? node.parent;
  }
  return titles; // e.g. ["[[uuid]]", "financial"]  (top-level first)
}

/** Collect the names of pages referenced anywhere in the ancestor chain
 *  (e.g. a top-level section whose title is `[[uuid]] {{renderer}}` and whose
 *  refs resolve to the "msft" page). Used for scope filtering. */
function ancestorRefNames(entity) {
  const names = [];
  let node = pick(entity, 'block/parent') ?? entity.parent;
  while (node) {
    const refs = pick(node, 'block/refs') ?? node.refs ?? [];
    for (const r of refs) {
      const rn = pick(r, 'block/name') ?? r.name;
      if (rn) names.push(String(rn).toLowerCase());
    }
    const nm = pick(node, 'block/name') ?? node.name; // pages have :block/name
    if (nm != null) break; // reached the page
    node = pick(node, 'block/parent') ?? node.parent;
  }
  return names;
}

function journalDayOf(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/** Only operate on the sm467d graph. */
async function ensureGraph() {
  const g = await logseq.App.getCurrentGraph();
  const hay = ((g && (g.name || g.path || g.url)) || '');
  if (!/sm467d/i.test(hay)) {
    logseq.UI.showMsg(`Morning Journal only runs on the sm467d graph (current: ${hay || 'unknown'}).`, 'warning');
    console.log('[morning-journal] wrong graph, skipping:', hay);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Date formatting for the journal page name (Logseq preferredDateFormat tokens)
// ---------------------------------------------------------------------------
function formatDate(d, fmt) {
  const months = ['January','February','March','April','May','June','July',
    'August','September','October','November','December'];
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const pad = (n) => String(n).padStart(2, '0');
  const day = d.getDate();
  const ord = (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const map = {
    EEEE: days[d.getDay()],
    EEE: days[d.getDay()].slice(0, 3),
    yyyy: d.getFullYear(),
    yy: String(d.getFullYear()).slice(-2),
    MMMM: months[d.getMonth()],
    MMM: months[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1),
    do: ord(day),
    dd: pad(day),
    M: d.getMonth() + 1,
    d: day,
  };
  return (fmt || 'MMM do, yyyy').replace(/EEEE|EEE|yyyy|yy|MMMM|MMM|MM|do|dd|M|d/g, (m) => map[m]);
}

// ---------------------------------------------------------------------------
// Query tracker tasks
// ---------------------------------------------------------------------------
async function dq(label, q) {
  try {
    const res = await logseq.DB.datascriptQuery(q);
    const rows = (res || []).map((r) => (Array.isArray(r) ? r[0] : r));
    console.log(`[morning-journal][diag] ${label}: ${rows.length}`, rows.slice(0, 5));
    return rows;
  } catch (e) {
    console.warn(`[morning-journal][diag] ${label} ERROR:`, e && e.message ? e.message : e);
    return [];
  }
}

/** List the top-level blocks (scope sections) under each tracker page. */
async function diagnose() {
  if (!(await ensureGraph())) return;
  for (const pg of TRACKER_PAGES) {
    const rows = await dq(`top-level blocks of "${pg}"`,
      `[:find (pull ?b [:block/uuid :block/title :block/order
                        {:block/refs [:block/name :block/title :block/uuid]}])
        :where [?b :block/page ?p][?p :block/name "${pg}"][?b :block/parent ?p]]`);
    const sections = rows
      .sort((a, b) => String(pick(a, 'block/order') ?? a.order).localeCompare(String(pick(b, 'block/order') ?? b.order)))
      .map((r) => {
        const raw = stripRenderer(pick(r, 'block/title') ?? r.title) || '(untitled)';
        const refs = (pick(r, 'block/refs') ?? r.refs ?? [])
          .map((x) => pick(x, 'block/name') ?? pick(x, 'block/title') ?? x.name ?? x.title)
          .filter(Boolean);
        return refs.length ? `${raw}  ->refs: [${refs.join(', ')}]` : raw;
      });
    console.log(`[morning-journal][diag] "${pg}" sections:`, JSON.stringify(sections, null, 1));
  }
  // Show the resolved open-task set with categories (no writing).
  const tasks = await queryTasks();
  const preview = [];
  for (const t of tasks) {
    if (isExcludedStatus(t)) continue;
    if (SCOPE_REF && !ancestorRefNames(t).includes(SCOPE_REF.toLowerCase())) continue;
    const ms = createdAtMs(t);
    if (ms == null) continue;
    preview.push({
      created: new Date(ms).toISOString(),
      ms,
      status: statusTitle(t),
      cats: categoryPath(t),
      uuid: uuidOf(t),
    });
  }
  preview.sort((a, b) => a.ms - b.ms);
  console.log(`[morning-journal][diag] open tasks = ${preview.length}`);
  console.log('[morning-journal][diag] sample (first 15):', JSON.stringify(preview.slice(0, 15)));
}

async function queryTasks() {
  const pageOr = '(or ' + TRACKER_PAGES.map((p) => `[?p :block/name "${p}"]`).join(' ') + ')';
  const q = `
    [:find (pull ?b [:block/uuid
                     :block/created-at
                     {:logseq.property/status [:db/ident :block/title]}
                     {:block/page [:block/name]}
                     {:block/parent [:block/title :block/name {:block/refs [:block/name]}
                       {:block/parent [:block/title :block/name {:block/refs [:block/name]}
                         {:block/parent [:block/title :block/name {:block/refs [:block/name]}
                           {:block/parent [:block/title :block/name {:block/refs [:block/name]}]}]}]}]}])
     :where
     [?b :logseq.property/status ?s]
     [?b :block/page ?p]
     ${pageOr}]`;
  const res = await logseq.DB.datascriptQuery(q);
  const rows = (res || []).map((r) => (Array.isArray(r) ? r[0] : r));
  console.log('[morning-journal] tracker tasks with a status:', rows.length);
  return rows;
}

/** Find the journal page entity for a given YYYYMMDD journal-day integer. */
async function getJournalPage(jdInt) {
  const res = await logseq.DB.datascriptQuery(
    `[:find (pull ?p [:block/uuid :block/name :block/title])
      :where [?p :block/journal-day ${jdInt}]]`);
  const rows = (res || []).map((r) => (Array.isArray(r) ? r[0] : r));
  return rows[0] || null;
}

/** Return the uuids of the top-level blocks on a journal page (by journal-day). */
async function journalTopBlocks(jdInt) {
  const res = await logseq.DB.datascriptQuery(
    `[:find (pull ?b [:block/uuid])
      :where [?p :block/journal-day ${jdInt}][?b :block/page ?p][?b :block/parent ?p]]`);
  const rows = (res || []).map((r) => (Array.isArray(r) ? r[0] : r));
  return rows.map((b) => uuidOf(b)).filter(Boolean);
}
function buildBlocks(taskRefs) {
  const topChildren = [];
  for (const p of taskRefs) {
    topChildren.push({ content: `[[${p.uuid}]]` });
  }
  topChildren.push({ content: '' });
  topChildren.push({ content: '[[completed]]' });

  return [
    { content: 'top picks {{renderer :todomaster}}', children: topChildren },
    { content: 'meetings', children: [{ content: '' }] },
    { content: 'journal', children: [{ content: '' }] },
  ];
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------
async function run() {
  try {
    if (!(await ensureGraph())) return;
    const today = journalDayOf(new Date());

    const tasks = await queryTasks();
    const picks = [];
    const catCounts = {};
    const statusCounts = {};
    let nNoUuid = 0, nNoCreated = 0, nExcluded = 0, nScopedOut = 0;
    for (const t of tasks) {
      const uuid = uuidOf(t);
      const ms = createdAtMs(t);
      if (!uuid || ms == null) { if (!uuid) nNoUuid++; else nNoCreated++; continue; }

      // Leave out backlog, wait, done, and canceled; keep everything else open.
      if (isExcludedStatus(t)) { nExcluded++; continue; }

      // Scope filter: keep only tasks under a section that references [[msft]].
      if (SCOPE_REF && !ancestorRefNames(t).includes(SCOPE_REF.toLowerCase())) {
        nScopedOut++;
        continue;
      }

      const cats = categoryPath(t);
      const topCat = cats[0] || '(none)';
      catCounts[topCat] = (catCounts[topCat] || 0) + 1;
      const st = statusTitle(t);
      statusCounts[st] = (statusCounts[st] || 0) + 1;
      picks.push({ uuid, ms });
    }
    // Sort by creation time, oldest first.
    picks.sort((a, b) => a.ms - b.ms);
    console.log(`[morning-journal][dbg] drops: noUuid=${nNoUuid} noCreated=${nNoCreated} excludedStatus=${nExcluded} scopedOut=${nScopedOut}`);
    console.log(`[morning-journal] open tasks (excl backlog/wait/done/canceled): ${picks.length}`);
    console.log('[morning-journal] category breakdown (top-level block):', catCounts);
    console.log('[morning-journal] status breakdown:', statusCounts);

    // Resolve today's journal page. In the DB version, name-based getPage is
    // unreliable, so locate the page by its :block/journal-day integer.
    const cfgs = await logseq.App.getUserConfigs();
    const displayName = formatDate(new Date(), cfgs.preferredDateFormat);
    console.log('[morning-journal] journal page:', displayName, 'journal-day:', today);

    let jp = await getJournalPage(today);
    if (!jp) {
      await logseq.Editor.createPage(
        displayName, {}, { journal: true, createFirstBlock: false, redirect: true }
      );
      jp = await getJournalPage(today);
      console.log('[morning-journal] created journal page');
    }
    // Use the page's own uuid for all reads/writes (name lookups are flaky).
    const pageRef = uuidOf(jp) || (pick(jp, 'block/name') ?? displayName);

    // Overwrite: clear ALL existing top-level blocks (incl. the default empty
    // first block) so re-running fully regenerates the journal. Loop until the
    // page is empty (Logseq may re-insert a placeholder block after removals).
    for (let pass = 0; pass < 5; pass++) {
      const kids = await journalTopBlocks(today);
      console.log(`[morning-journal] clear pass ${pass}: ${kids.length} block(s)`);
      if (kids.length === 0) break;
      for (const u of kids) {
        try {
          await logseq.Editor.removeBlock(u);
        } catch (e) {
          console.warn('[morning-journal] removeBlock failed for', u, e && e.message);
        }
      }
    }

    const tree = buildBlocks(picks);
    for (const node of tree) {
      const blk = await logseq.Editor.appendBlockInPage(pageRef, node.content);
      if (blk && node.children && node.children.length) {
        await logseq.Editor.insertBatchBlock(blk.uuid, node.children, { sibling: false });
      }
    }

    logseq.UI.showMsg(
      `Morning Journal: ${picks.length} open task(s) added.`,
      'success'
    );
  } catch (e) {
    console.error('[morning-journal] failed:', e);
    logseq.UI.showMsg('Morning Journal failed: ' + (e && e.message ? e.message : e), 'error');
  }
}

// ---------------------------------------------------------------------------
// Register triggers
// ---------------------------------------------------------------------------
function main() {
  console.info('[morning-journal] loaded v17 (created-at sort, short-key aware)');

  logseq.App.registerCommandPalette(
    {
      key: 'morning-journal-create',
      label: "Morning: Create today's journal",
      keybinding: { binding: 'mod+alt+m' },
    },
    run
  );

  logseq.App.registerCommandPalette(
    { key: 'morning-journal-diagnose', label: 'Morning: Diagnose tasks' },
    diagnose
  );

  logseq.Editor.registerSlashCommand('Morning Journal', run);
}

logseq.ready(main).catch(console.error);
