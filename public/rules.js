// Game rules shared by the browser and the server, so both agree on every shot.
// Squares are numbered 0-99 (row * 10 + column). A shot is {i, res, t, b?}:
// res is "miss" | "hit" | "sunk" (null while waiting for the defender), t is the
// shooter's turn number, and b marks shots that came from a cluster bomb.
(function (root) {
  const COLS = "ABCDEFGHIJ";
  const SHIPS = [
    {id:"carrier", name:"Carrier", len:5},
    {id:"battleship", name:"Battleship", len:4},
    {id:"cruiser", name:"Cruiser", len:3},
    {id:"submarine", name:"Submarine", len:3},
    {id:"destroyer", name:"Destroyer", len:2},
  ];
  const coord = i => COLS[i % 10] + (Math.floor(i / 10) + 1);
  const isHit = s => s.res === "hit" || s.res === "sunk";

  function cellsFor(len, i, across) {
    const r = Math.floor(i / 10), c = i % 10, out = [];
    for (let k = 0; k < len; k++) {
      const rr = across ? r : r + k, cc = across ? c + k : c;
      out.push(rr < 10 && cc < 10 ? rr * 10 + cc : -1);
    }
    return out;
  }
  const fits = (fleet, cells) => cells.every(i => i >= 0 && !fleet.some(s => s.cells.includes(i)));

  function randomFleet() {
    const f = [];
    for (const sh of SHIPS) {
      for (;;) {
        const cells = cellsFor(sh.len, Math.floor(Math.random() * 100), Math.random() < .5);
        if (fits(f, cells)) { f.push({id:sh.id, name:sh.name, len:sh.len, cells}); break; }
      }
    }
    return f;
  }

  // Checks a fleet sent by a player: exactly the five ships, straight, in bounds, not overlapping.
  function validFleet(fleet) {
    if (!Array.isArray(fleet) || fleet.length !== SHIPS.length) return false;
    const used = new Set();
    for (const sh of SHIPS) {
      const s = fleet.find(f => f && f.id === sh.id);
      if (!s || !Array.isArray(s.cells) || s.cells.length !== sh.len) return false;
      const cells = s.cells;
      if (!cells.every(i => Number.isInteger(i) && i >= 0 && i < 100 && !used.has(i))) return false;
      const step = cells[1] - cells[0];
      if (step !== 1 && step !== 10) return false;
      for (let k = 1; k < cells.length; k++) {
        if (cells[k] - cells[k - 1] !== step) return false;
        if (step === 1 && Math.floor(cells[k] / 10) !== Math.floor(cells[0] / 10)) return false;
      }
      cells.forEach(i => used.add(i));
    }
    return true;
  }
  const cleanFleet = fleet => SHIPS.map(sh => {
    const s = fleet.find(f => f.id === sh.id);
    return {id:sh.id, name:sh.name, len:sh.len, cells:s.cells.slice()};
  });

  function resolveShot(fleet, prior, i) {
    const s = fleet.find(s => s.cells.includes(i));
    if (!s) return {i, res:"miss"};
    const hits = new Set(prior.filter(isHit).map(p => p.i));
    hits.add(i);
    if (s.cells.every(x => hits.has(x))) return {i, res:"sunk", ship:s.name, shipId:s.id, cells:s.cells.slice()};
    return {i, res:"hit"};
  }
  // Answers every waiting shot in `shots` (fired at `fleet`), in order. Returns a new array.
  function resolvePending(fleet, shots) {
    const out = [];
    for (const s of shots) {
      if (s.res != null) { out.push(s); continue; }
      const r = resolveShot(fleet, out, s.i);
      r.t = s.t; if (s.b) r.b = 1;
      out.push(r);
    }
    return out;
  }
  function allSunk(fleet, shots) {
    const hits = new Set(shots.filter(isHit).map(p => p.i));
    return fleet.every(s => s.cells.every(x => hits.has(x)));
  }

  // Cluster bomb: the 3 x 3 block centred on the target, clipped at the edges.
  function blastCells(i) {
    const r = Math.floor(i / 10), c = i % 10, out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < 10 && cc >= 0 && cc < 10) out.push(rr * 10 + cc);
    }
    return out;
  }

  // Groups shots into turns. Older games stored no turn numbers; each of their shots is its own turn.
  function turns(shots) {
    const by = new Map();
    shots.forEach((s, k) => {
      const t = s.t == null ? k : s.t;
      if (!by.has(t)) by.set(t, []);
      by.get(t).push(s);
    });
    return [...by.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }
  const nextTurn = shots => turns(shots).length;

  // A cluster bomb is earned by sinking two ships in a row without a miss in between.
  // Using one starts the count again. Returns bombs ready and progress toward the next (0 or 1).
  function bombState(shots) {
    let earned = 0, used = 0, sinks = 0;
    for (const turn of turns(shots)) {
      if (turn.some(s => s.res == null)) break;
      if (turn[0].b) { used++; sinks = 0; continue; }
      const s = turn[0];
      if (s.res === "miss") sinks = 0;
      else if (s.res === "sunk" && ++sinks === 2) { earned++; sinks = 0; }
    }
    return {ready:Math.max(0, earned - used), progress:sinks};
  }

  // Builds the waiting shots for one turn. Returns null if the move isn't allowed.
  function planShots(shots, i, bomb) {
    if (!Number.isInteger(i) || i < 0 || i > 99) return null;
    const taken = new Set(shots.map(s => s.i));
    const t = nextTurn(shots);
    if (bomb) {
      if (bombState(shots).ready < 1) return null;
      const cells = blastCells(i).filter(x => !taken.has(x));
      return cells.length ? cells.map(x => ({i:x, res:null, t, b:1})) : null;
    }
    return taken.has(i) ? null : [{i, res:null, t}];
  }

  function statsOf(shots) {
    let run = 0, best = 0;
    for (const s of shots) { run = isHit(s) ? run + 1 : 0; best = Math.max(best, run); }
    const hits = shots.filter(isHit).length;
    return {fired:shots.length, hits, acc:shots.length ? Math.round(hits / shots.length * 100) : 0, best,
      sunk:shots.filter(s => s.res === "sunk").length, turns:turns(shots).length};
  }

  const api = {COLS, SHIPS, coord, isHit, cellsFor, fits, randomFleet, validFleet, cleanFleet, resolveShot,
    resolvePending, allSunk, blastCells, turns, nextTurn, bombState, planShots, statsOf};
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Rules = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
