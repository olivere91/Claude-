// Sink the Fleet game server. No dependencies: Node's built-in http module serves the page,
// keeps two-player rooms in memory, pushes live updates over Server-Sent Events, and stores
// finished games for the leaderboard in a JSON file.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Rules = require("./public/rules.js");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const RESULTS_FILE = path.join(DATA_DIR, "results.json");
const MAX_RESULTS = 5000;          // oldest results are dropped past this
const MAX_ROOMS = 2000;
const ROOM_IDLE_MS = 24 * 60 * 60 * 1000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O, so codes are easy to read aloud

// ---------- leaderboard storage ----------
fs.mkdirSync(DATA_DIR, {recursive:true});
let results = [];
try { results = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")); } catch (e) { results = []; }
let saveTimer = null;
function saveResults() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = RESULTS_FILE + ".tmp";
    fs.writeFile(tmp, JSON.stringify(results), err => {
      if (err) return console.error("Couldn't save results:", err.message);
      fs.rename(tmp, RESULTS_FILE, e => e && console.error("Couldn't save results:", e.message));
    });
  }, 200);
}

// ---------- rooms ----------
const rooms = new Map();
const newToken = () => crypto.randomBytes(18).toString("base64url");
function newCode() {
  for (;;) {
    let c = "";
    for (let k = 0; k < 4; k++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}
const other = s => s === "A" ? "B" : "A";
function cleanName(n) {
  const s = String(n || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
  return s || null;
}
function seatOf(room, token) {
  if (!token) return null;
  for (const s of ["A", "B"]) if (room.players[s] && room.players[s].token === token) return s;
  return null;
}
function phaseOf(room) {
  if (room.winner) return "over";
  return room.players.A && room.players.B && room.players.A.ready && room.players.B.ready ? "play" : "setup";
}
function freshRound(room, first) {
  room.round += 1;
  room.first = room.turn = first;
  room.winner = null;
  room.shots = {A:[], B:[]};
  room.recorded = false;
  for (const s of ["A", "B"]) if (room.players[s]) { room.players[s].fleet = null; room.players[s].ready = false; }
}

// What one viewer is allowed to see: their own fleet, never the opponent's until the game ends.
function viewFor(room, token) {
  const seat = seatOf(room, token), phase = phaseOf(room);
  const pub = s => room.players[s] ? {name:room.players[s].name, ready:room.players[s].ready, online:connectedSeats(room).has(s)} : null;
  return {
    code:room.code, round:room.round, phase, seat, turn:room.turn, first:room.first, winner:room.winner,
    players:{A:pub("A"), B:pub("B")},
    fleet:seat && room.players[seat].fleet ? room.players[seat].fleet : null,
    shots:room.shots,
    reveal:phase === "over" ? {A:room.players.A && room.players.A.fleet, B:room.players.B && room.players.B.fleet} : null,
  };
}
function connectedSeats(room) {
  const set = new Set();
  for (const c of room.clients) { const s = seatOf(room, c.token); if (s) set.add(s); }
  return set;
}
function broadcast(room) {
  room.updatedAt = Date.now();
  for (const c of room.clients) c.res.write(`data: ${JSON.stringify(viewFor(room, c.token))}\n\n`);
}
function record(room) {
  if (room.recorded || !room.winner) return;
  room.recorded = true;
  const p = ["A", "B"].map(s => {
    const st = Rules.statsOf(room.shots[s]);
    return {key:"n:" + room.players[s].name.toLowerCase(), name:room.players[s].name, won:s === room.winner,
      fired:st.fired, hits:st.hits, sunk:st.sunk, turns:st.turns};
  });
  results.unshift({at:new Date().toISOString(), mode:"online", p});
  if (results.length > MAX_RESULTS) results.length = MAX_RESULTS;
  saveResults();
}

// Rooms nobody has touched for a day, with nobody connected, are removed.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (!room.clients.size && now - room.updatedAt > ROOM_IDLE_MS) rooms.delete(code);
}, 10 * 60 * 1000).unref();

// ---------- actions ----------
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function getRoom(code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) throw new HttpError(404, "There's no game with that code. Check the code, or start a new game.");
  return room;
}
function requireSeat(room, token) {
  const seat = seatOf(room, token);
  if (!seat) throw new HttpError(403, "You're not seated at this game.");
  return seat;
}

const actions = {
  create(body) {
    if (rooms.size >= MAX_ROOMS) throw new HttpError(503, "The server is full right now. Try again in a little while.");
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, "Enter a captain name first.");
    const room = {code:newCode(), round:0, first:"A", turn:"A", winner:null, shots:{A:[], B:[]}, recorded:false,
      players:{A:{name, token:newToken(), fleet:null, ready:false}, B:null}, clients:new Set(), updatedAt:Date.now()};
    freshRound(room, "A");
    rooms.set(room.code, room);
    return {code:room.code, token:room.players.A.token, seat:"A"};
  },
  join(body, room) {
    const again = seatOf(room, body.token);
    if (again) return {code:room.code, token:body.token, seat:again};
    const name = cleanName(body.name);
    if (!name) throw new HttpError(400, "Enter a captain name first.");
    const seat = !room.players.A ? "A" : !room.players.B ? "B" : null;
    if (!seat) throw new HttpError(409, "Both seats at this game are taken.");
    const opp = room.players[other(seat)];
    if (opp && opp.name.toLowerCase() === name.toLowerCase()) throw new HttpError(409, `${opp.name} is already at this table. Pick a different name.`);
    room.players[seat] = {name, token:newToken(), fleet:null, ready:false};
    broadcast(room);
    return {code:room.code, token:room.players[seat].token, seat};
  },
  fleet(body, room) {
    const seat = requireSeat(room, body.token);
    if (phaseOf(room) !== "setup") throw new HttpError(409, "Fleets are already deployed for this game.");
    if (!Rules.validFleet(body.ships)) throw new HttpError(400, "That fleet isn't valid. Place all five ships in straight lines without overlapping.");
    room.players[seat].fleet = Rules.cleanFleet(body.ships);
    room.players[seat].ready = true;
    broadcast(room);
    return {ok:true};
  },
  fire(body, room) {
    const seat = requireSeat(room, body.token);
    if (phaseOf(room) !== "play") throw new HttpError(409, "The battle hasn't started yet.");
    if (room.turn !== seat) throw new HttpError(409, "It's not your turn.");
    if (body.bomb && Rules.bombState(room.shots[seat]).ready < 1) throw new HttpError(409, "You don't have a cluster bomb yet.");
    const planned = Rules.planShots(room.shots[seat], body.i, !!body.bomb);
    if (!planned) throw new HttpError(400, body.bomb ? "You can't drop a cluster bomb there." : "You've already fired there.");
    const enemy = room.players[other(seat)].fleet;
    room.shots[seat] = Rules.resolvePending(enemy, room.shots[seat].concat(planned));
    if (Rules.allSunk(enemy, room.shots[seat])) { room.winner = seat; record(room); }
    else room.turn = other(seat);
    broadcast(room);
    return {ok:true};
  },
  rematch(body, room) {
    requireSeat(room, body.token);
    if (phaseOf(room) !== "over") throw new HttpError(409, "Finish this game first.");
    freshRound(room, other(room.winner)); // the loser goes first
    broadcast(room);
    return {ok:true};
  },
  leave(body, room) {
    const seat = requireSeat(room, body.token);
    if (phaseOf(room) === "play") throw new HttpError(409, "You can't leave in the middle of a battle.");
    room.players[seat] = null;
    if (room.players[other(seat)]) room.players[other(seat)].ready = false;
    freshRound(room, "A");
    broadcast(room);
    return {ok:true};
  },
};

// ---------- http ----------
const TYPES = {".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8",
  ".svg":"image/svg+xml", ".png":"image/png", ".ico":"image/x-icon", ".json":"application/json"};
const SECURITY = {
  "X-Content-Type-Options":"nosniff",
  "Referrer-Policy":"same-origin",
  "Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:",
};
function send(res, status, obj) {
  res.writeHead(status, {"Content-Type":"application/json", "Cache-Control":"no-store", ...SECURITY});
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > 32 * 1024) { reject(new HttpError(413, "Request too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(new HttpError(400, "Couldn't read that request.")); }
    });
    req.on("error", reject);
  });
}
// A simple per-address limit on actions, to slow down anyone hammering the server.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), h = hits.get(ip) || {n:0, since:now};
  if (now - h.since > 10000) { h.n = 0; h.since = now; }
  h.n++; hits.set(ip, h);
  return h.n > 60;
}
setInterval(() => hits.clear(), 60 * 1000).unref();

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {"Content-Type":"text/plain", ...SECURITY}); return res.end("Not found"); }
    res.writeHead(200, {"Content-Type":TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control":file.endsWith(".html") ? "no-cache" : "public, max-age=300", ...SECURITY});
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (parts[0] !== "api") return serveStatic(req, res, url.pathname);

    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, {ok:true, rooms:rooms.size});
    if (req.method === "GET" && url.pathname === "/api/leaderboard") return send(res, 200, {results:results.slice(0, 1000)});

    // GET /api/rooms/:code/stream?token=...  live updates for one viewer
    if (req.method === "GET" && parts[1] === "rooms" && parts[3] === "stream") {
      const room = getRoom(parts[2]);
      const client = {res, token:url.searchParams.get("token") || ""};
      res.writeHead(200, {"Content-Type":"text/event-stream", "Cache-Control":"no-store", "Connection":"keep-alive",
        "X-Accel-Buffering":"no", ...SECURITY});
      res.write("retry: 2000\n\n");
      room.clients.add(client);
      broadcast(room); // tells the other player this one is online
      const beat = setInterval(() => res.write(": keep-alive\n\n"), 25000);
      req.on("close", () => { clearInterval(beat); room.clients.delete(client); if (rooms.has(room.code)) broadcast(room); });
      return;
    }

    if (req.method !== "POST") throw new HttpError(405, "Method not allowed.");
    if (limited(req.socket.remoteAddress)) throw new HttpError(429, "Slow down a little and try again.");
    const body = await readBody(req);
    if (url.pathname === "/api/rooms") return send(res, 200, actions.create(body));
    // POST /api/rooms/:code/:action
    if (parts[1] === "rooms" && parts.length === 4 && actions[parts[3]] && parts[3] !== "create")
      return send(res, 200, actions[parts[3]](body, getRoom(parts[2])));
    throw new HttpError(404, "Not found.");
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, {error:e.message});
    console.error(e);
    send(res, 500, {error:"Something went wrong on the server."});
  }
});

server.listen(PORT, () => console.log(`Sink the Fleet is running on http://localhost:${PORT}`));
