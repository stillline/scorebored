// Bracket games read from the public shufflepolo.com tournament page.
//
// Why: the scoreboard feed (scoreboard-feed) lists only games that exist with
// both teams; unplayed bracket games (empty slots, "TBD") are not in it, so
// bracket.json could not show the ladder ahead of play. The tournament page
// draws the whole ladder, so we render it headless with the Pi's Chromium and
// read the game cards back out of the DOM. Nothing is fetched beyond what any
// browser loads to show the page.
//
// What the page gives us (verified 2026-10-14 against the Back to School Bash
// bracket): each game card has data-testid="bracket-game-row-<game uuid>",
// with children bracket-game-number-<id> ("Game 16"), bracket-game-time-<id>
// ("02:30 PM", tournament local time) and bracket-game-slot-team1/team2-<team
// uuid> (team name, then the score). The card's wrapper has an inline
// `grid-area: row / column` whose column (1, 3, 5, ...) is the round: the
// section's round labels ("Round 1", ..., "Winners Final") appear in that
// order just before the cards. Sections are "Grand Final", "Winners Bracket",
// "Losers Bracket"; each bracket is headed by an <h3> ("Main Bracket").
//
// These test ids are the page's own stable hooks; the Tailwind class names are
// not relied on. If the page changes shape, parseBracket() returns [] and the
// caller keeps its last good result.
//
// CLI: node page_bracket.js <tournament url>   prints the parsed games as JSON.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROMIUM = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
// Own profile dir: never share the kiosk display's (/tmp/chromium-atem-display).
const PROFILE_DIR = path.join(os.tmpdir(), 'chromium-shufflepolo-page');
const RENDER_TIMEOUT_MS = 60000;

/** Renders the page headless and resolves with the DOM as HTML. */
function renderPage(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${PROFILE_DIR}`,
      '--virtual-time-budget=15000', // let the app fetch and draw before dumping
      '--window-size=1400,3000',
      '--dump-dom', url,
    ];
    execFile(CHROMIUM, args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`chromium: ${err.message.split('\n')[0]}`));
      resolve(stdout);
    });
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
function unescapeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (e[0] === '#') return String.fromCodePoint(parseInt(e[1] === 'x' ? e.slice(2) : e.slice(1), e[1] === 'x' ? 16 : 10));
    return m;
  });
}

const SECTION_RE = /^(grand final|winners bracket|losers bracket|final|bracket)$/i;
const ROUND_LABEL_RE = /^(round \d+|winners final|losers final|grand final|final|semifinals?|quarterfinals?)$/i;

/**
 * Parses the rendered page into bracket games.
 * @returns {Array<{id, bracket, section, round, roundLabel, number, time, team1, team2, score1, score2}>}
 */
function parseBracket(html) {
  // Tokenize: tags and text, in document order.
  const tokens = [];
  const re = /<([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|<\/([a-zA-Z][a-zA-Z0-9]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) tokens.push({ open: m[1].toLowerCase(), attrs: m[2] || '' });
    else if (m[3]) tokens.push({ close: m[3].toLowerCase() });
    else if (m[4]) { const t = unescapeHtml(m[4]).trim(); if (t) tokens.push({ text: t }); }
  }
  const testid = (attrs) => { const a = /data-testid="([^"]+)"/.exec(attrs); return a ? a[1] : null; };
  const gridArea = (attrs) => { const a = /grid-area:\s*(\d+)\s*\/\s*(\d+)(?:\s*\/\s*(\d+))?/.exec(attrs); return a ? { row: Number(a[1]), column: Number(a[2]), rowEnd: a[3] ? Number(a[3]) : Number(a[1]) + 1 } : null; };

  const games = [];
  let bracket = null, section = null, roundLabels = [];
  let lastArea = null, inH3 = false, h3TextSeen = false;
  let game = null, slot = null, depthAtGame = 0, depth = 0;

  const finish = () => { if (game) { games.push(game); game = null; slot = null; } };

  for (const tok of tokens) {
    if (tok.open) {
      depth++;
      const id = testid(tok.attrs);
      const area = gridArea(tok.attrs); if (area) lastArea = area;
      if (tok.open === 'h3') { inH3 = true; h3TextSeen = false; }
      if (id && id.startsWith('bracket-game-row-')) {
        finish();
        const column = lastArea ? lastArea.column : 1;
        const round = Math.floor((column + 1) / 2); // columns 1,3,5,... are rounds 1,2,3,...
        game = { id: id.slice('bracket-game-row-'.length), bracket, section, round,
          grid: lastArea ? { row: lastArea.row, rowEnd: lastArea.rowEnd, column } : null,
          roundLabel: roundLabels[round - 1] || (roundLabels.length === 0 && section ? section : `Round ${round}`),
          number: null, time: null, team1: null, team2: null, score1: null, score2: null };
        depthAtGame = depth; lastArea = null;
      } else if (game && id && id.startsWith('bracket-game-slot-team')) {
        slot = id.startsWith('bracket-game-slot-team1') ? 1 : 2;
        const teamId = id.replace(/^bracket-game-slot-team[12]-?/, '');
        game[`team${slot}Id`] = teamId || null;
      } else if (game && id && id.startsWith('bracket-game-number-')) game._want = 'number';
      else if (game && id && id.startsWith('bracket-game-time-')) game._want = 'time';
    } else if (tok.close) {
      if (tok.close === 'h3') inH3 = false;
      if (game && depth === depthAtGame) finish();
      depth--;
    } else if (tok.text) {
      const t = tok.text;
      if (game) {
        if (game._want === 'number') { const n = /(\d+)/.exec(t); if (n) game.number = Number(n[1]); delete game._want; }
        else if (game._want === 'time') { game.time = t; delete game._want; }
        else if (slot && game[`team${slot}`] === null) game[`team${slot}`] = t;
        else if (slot && /^\d+$/.test(t) && game[`score${slot}`] === null) game[`score${slot}`] = Number(t);
      } else if (inH3) {
        // first text only: the h3 also holds a "(double elimination)" span
        if (!h3TextSeen) { bracket = t; section = null; roundLabels = []; h3TextSeen = true; }
      }
      else if (SECTION_RE.test(t)) { section = t; roundLabels = []; }
      else if (ROUND_LABEL_RE.test(t)) roundLabels.push(t);
    }
  }
  finish();
  for (const g of games) { delete g._want; if (g.team1 === null) g.team1 = 'TBD'; if (g.team2 === null) g.team2 = 'TBD'; }
  return games;
}

/** The tournament's name: the page's first <h1>. */
function parseTitle(html) {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m ? unescapeHtml(m[1].replace(/<[^>]+>/g, '')).trim() : null;
}

/**
 * The page's Teams section: data-testid="team-card-<team uuid>" wrapping the
 * name, a "Seed N" badge (team-seed-badge) and the roster (team-roster,
 * "A · B · C"). Returns [{ id, name, seed, roster: [names] }] sorted by seed.
 */
function parseTeams(html) {
  const teams = [];
  const re = /data-testid="team-card-([0-9a-f-]{36})"([\s\S]*?)(?=data-testid="team-card-|$)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const chunk = m[2];
    const texts = []; const tre = /data-testid="([^"]+)"|>([^<>]+)</g; let t;
    while ((t = tre.exec(chunk)) !== null) {
      if (t[1]) texts.push({ id: t[1] });
      else if (t[2] && t[2].trim()) texts.push({ text: unescapeHtml(t[2].trim()) });
    }
    const team = { id: m[1], name: null, seed: null, roster: [] };
    let want = 'name';
    for (const x of texts) {
      if (x.id === 'team-seed-badge') want = 'seed';
      else if (x.id === 'team-roster') want = 'roster';
      else if (x.id) continue;
      else if (want === 'name' && team.name === null) team.name = x.text;
      else if (want === 'seed') { const n = /(\d+)/.exec(x.text); if (n) team.seed = Number(n[1]); want = null; }
      else if (want === 'roster') { team.roster = x.text.split(/\s*[·•]\s*/).filter(Boolean); want = null; }
    }
    if (team.name) teams.push(team);
  }
  return teams.sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999) || a.name.localeCompare(b.name));
}

/** Render + parse title, games and teams. Rejects only on render failure. */
async function readBracketPage(url) {
  const html = await renderPage(url);
  return { title: parseTitle(html), games: parseBracket(html), teams: parseTeams(html) };
}

/** Render + parse. Resolves with [] (never rejects on page shape) but rejects on render failure. */
async function readBracketGames(url) {
  const html = await renderPage(url);
  return parseBracket(html);
}

module.exports = { renderPage, parseBracket, parseTitle, parseTeams, readBracketGames, readBracketPage };

if (require.main === module) {
  const url = process.argv[2];
  if (!url) { console.error('usage: node page_bracket.js <tournament url> [saved.html]'); process.exit(2); }
  const run = process.argv[3] ? Promise.resolve(parseBracket(fs.readFileSync(process.argv[3], 'utf8'))) : readBracketGames(url);
  run.then((games) => { console.log(JSON.stringify(games, null, 1)); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
