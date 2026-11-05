const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const server = http.createServer((req, res) => {
    let filePath = path.join(__dirname, 'www', req.url === '/' ? 'index.html' : req.url);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200);
        res.end(data);
    });
});

const wss = new WebSocket.Server({ server });

const scale = 4;
const MAX_PLAYERS = 10;
const ROOM_COUNT = 10;
const ROOM_TIMEOUT = 5 * 60 * 1000;
const CAR_WIDTH = 60;
const CAR_HEIGHT = 112;

let leaderboard = [];
let circuitLeaderboards = {};
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
        const data = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
        leaderboard = JSON.parse(data);
        if (!Array.isArray(leaderboard)) leaderboard = [];
    }
} catch (e) {
    leaderboard = [];
}

try {
    const clFile = path.join(__dirname, 'circuitLeaderboards.json');
    if (fs.existsSync(clFile)) {
        const d = fs.readFileSync(clFile, 'utf8');
        const parsed = JSON.parse(d);
        if (parsed && typeof parsed === 'object') circuitLeaderboards = parsed;
    }
} catch (e) { circuitLeaderboards = {}; }
function saveLeaderboard() {
    try {
        fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2), 'utf8');
    } catch (e) {}
}

function saveCircuitLeaderboards() {
    try {
        fs.writeFileSync(path.join(__dirname, 'circuitLeaderboards.json'), JSON.stringify(circuitLeaderboards, null, 2), 'utf8');
    } catch (e) {}
}
const tracksData = JSON.parse(fs.readFileSync(path.join(__dirname, 'www', 'tracks.json'), 'utf8'));
const DEFAULT_TRACK = tracksData['Italian Grand Prix'];
function getRoadWidth(circuit) {
    return circuit === 'Monaco Grand Prix' ? 123 : 300;
}
let rooms = {};
let playerWs = {}; // playerId -> ws
let playerRoom = {}; // playerId -> roomId

for (let i = 0; i < ROOM_COUNT; i++) {
    rooms[i] = {
        id: i,
        players: {},
        phase: 'lobby', // lobby, qualif, race, finished
        started: false,
        raceStarted: false,
        startTime: null,
        circuit: 'Italian Grand Prix',
        trackPoints: DEFAULT_TRACK,
        roadWidth: 300,
        qualifStartTime: null,
        qualifDuration: 5 * 60 * 1000,
        readyStartTime: null,
        readyDuration: 60 * 1000,
        lightsStartTime: null,
        lightsOutTime: null,
        raceStartTime: null,
        targetLaps: 10,
        winner: null,
        timer: null,
        bestQualifS1Time: 0,
        bestQualifS2Time: 0,
        bestQualifS3Time: 0
    };
}

const constants = {
    maxSpeed: 20,
    reverseMaxSpeed: 5,
    accel: 0.4,
    friction: 0.04,
    brake: 0.6,
    turnSpeed: 0.045
};

function checkpointIndices(pts) {
    const n = pts.length;
    if (n < 2) return [0, Math.max(0, n-1)];
    const segs = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        segs.push(d);
        total += d;
    }
    const targets = [total / 3, (2 * total) / 3];
    const idxs = [];
    for (let t = 0; t < targets.length; t++) {
        let c = 0;
        for (let i = 0; i < n; i++) {
            const seg = segs[i];
            if (c + seg >= targets[t]) { idxs.push(i); break; }
            c += seg;
        }
        if (idxs.length <= t) idxs.push(n - 1);
    }
    if (idxs[0] === idxs[1]) idxs[1] = Math.min(n - 1, idxs[1] + 1);
    return idxs;
}
function splitIndices(pts) {
    const n = pts.length;
    if (n < 2) return [0, Math.max(0, n-1)];
    const segs = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        segs.push(d);
        total += d;
    }
    const targets = [total / 3, (2 * total) / 3];
    const idxs = [];
    for (let t = 0; t < targets.length; t++) {
        let c = 0;
        for (let i = 0; i < n; i++) {
            const seg = segs[i];
            if (c + seg >= targets[t]) { idxs.push(i); break; }
            c += seg;
        }
        if (idxs.length <= t) idxs.push(n - 1);
    }
    if (idxs[0] === idxs[1]) idxs[1] = Math.min(n - 1, idxs[1] + 1);
    return idxs;
}
function isOnTrack(x, y, points, roadWidth) {
    const pts = points || DEFAULT_TRACK;
    const rw = roadWidth || 300;
    const roadWidthVal = rw;
    const halfWidth = roadWidthVal / 2;

    for (let i = 0; i < pts.length; i++) {
        let p1 = pts[i];
        let p2 = pts[(i + 1) % pts.length];

        let A = x - p1.x;
        let B = y - p1.y;
        let C = p2.x - p1.x;
        let D = p2.y - p1.y;

        let dot = A * C + B * D;
        let lenSq = C * C + D * D;
        let param = -1;
        if (lenSq !== 0) param = dot / lenSq;

        let xx, yy;
        if (param < 0) {
            xx = p1.x;
            yy = p1.y;
        } else if (param > 1) {
            xx = p2.x;
            yy = p2.y;
        } else {
            xx = p1.x + param * C;
            yy = p1.y + param * D;
        }

        let dx = x - xx;
        let dy = y - yy;
        let dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= halfWidth) {
            return true;
        }
    }
    return false;
}

function projectRect(cx, cy, angle, halfW, halfH, axis) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const ax = { x: cos, y: sin };
    const ay = { x: -sin, y: cos };
    const r = halfW * Math.abs(ax.x * axis.x + ax.y * axis.y) + halfH * Math.abs(ay.x * axis.x + ay.y * axis.y);
    const c = cx * axis.x + cy * axis.y;
    return { min: c - r, max: c + r };
}

function collideOBB(c1, a1, c2, a2) {
    const halfW = CAR_HEIGHT / 2;
    const halfH = CAR_WIDTH / 2;
    const axes = [
        { x: Math.cos(a1), y: Math.sin(a1) },
        { x: -Math.sin(a1), y: Math.cos(a1) },
        { x: Math.cos(a2), y: Math.sin(a2) },
        { x: -Math.sin(a2), y: Math.cos(a2) }
    ];

    let minOverlap = Infinity;
    let mtvAxis = null;
    for (const axis of axes) {
        const p1 = projectRect(c1.x, c1.y, a1, halfW, halfH, axis);
        const p2 = projectRect(c2.x, c2.y, a2, halfW, halfH, axis);
        const overlap = Math.min(p1.max, p2.max) - Math.max(p1.min, p2.min);
        if (overlap <= 0) return null;
        if (overlap < minOverlap) {
            minOverlap = overlap;
            mtvAxis = axis;
        }
    }

    const dx = c2.x - c1.x;
    const dy = c2.y - c1.y;
    if (dx * mtvAxis.x + dy * mtvAxis.y < 0) {
        mtvAxis = { x: -mtvAxis.x, y: -mtvAxis.y };
    }
    return { overlap: minOverlap, nx: mtvAxis.x, ny: mtvAxis.y };
}

function gridPosition(tp, idx) {
    const p0 = tp[0];
    const p1 = tp[1] || tp[0];
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const row = idx;
    const side = (idx % 2 === 0) ? -1 : 1;
    const across = side * 80;
    const markerDistance = 40 + idx * 120;
    const carDistance = markerDistance + 70;
    return {
        x: p0.x + nx * across - (dx / len) * carDistance,
        y: p0.y + ny * across - (dy / len) * carDistance,
        angle: Math.atan2(dx, -dy)
    };
}

function startRacePhase(room) {
    let sorted = Object.values(room.players).sort((a, b) => {
        let ta = a.race.bestTime || Infinity;
        let tb = b.race.bestTime || Infinity;
        return ta - tb;
    });
    sorted.forEach((p, idx) => {
        const tp = room.trackPoints || DEFAULT_TRACK;
        const gp = gridPosition(tp, idx);
        p.car.x = gp.x;
        p.car.y = gp.y;
        p.car.angle = gp.angle;
        p.car.speed = 0;
        p.race.laps = 0;
        p.race.finished = false;
        p.race.finishTime = null;
        p.race.passedLineLastFrame = false;
        p.race.checkpoint1Passed = false;
        p.race.checkpoint2Passed = false;
        p.race.passedCp1 = false;
        p.race.passedCp2 = false;
        p.race.split1Time = 0;
        p.race.split2Time = 0;
        p.race.lastS1Time = 0;
        p.race.lastS2Time = 0;
        p.race.lastS3Time = 0;
        p.race.bestS1Time = 0;
        p.race.bestS2Time = 0;
        p.race.bestS3Time = 0;
        p.race.prevAlong = null;
        p.race.ready = false;
        p.race.startTime = Date.now();
    });
    room.phase = 'lights';
    room.lightsStartTime = Date.now();
    room.lightsOutTime = room.lightsStartTime + 4000 + (1000 + Math.floor(Math.random() * 4001));
    room.raceStartTime = null;
    room.readyStartTime = null;
}

wss.on('connection', (ws) => {
    const playerId = 'player_' + Math.random().toString(36).substr(2, 9);
    console.log(`Joueur connecté : ${playerId}`);
    playerWs[playerId] = ws;

    let currentRoom = null;
    let nickname = 'Pilote';
    let carImage = 'ferrari.png';

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'join') {
                nickname = data.nickname || 'Pilote';
                if (data.car) carImage = data.car;
            }
            
            if (data.type === 'joinRoom') {
                let roomId = data.roomId;
                if (roomId < 0 || roomId >= ROOM_COUNT) return;
                
                if (currentRoom !== null && rooms[currentRoom]) {
                    delete rooms[currentRoom].players[playerId];
                }
                
                currentRoom = roomId;
                playerRoom[playerId] = roomId;
                let room = rooms[roomId];
                
                const playerCount = Object.keys(room.players).length;
                if (playerCount >= MAX_PLAYERS) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Salle complète' }));
                    return;
                }
                
                const tp = room.trackPoints || DEFAULT_TRACK;
                const gp = gridPosition(tp, playerCount);
                const startX = gp.x;
                const startY = gp.y;
                const startAngle = gp.angle;
                
                room.players[playerId] = {
                    id: playerId,
                    nickname: nickname,
                    carImage: carImage,
                    car: { x: startX, y: startY, angle: startAngle, speed: 0 },
                    inputs: { left: false, right: false, accel: false, brake: false },
                    race: { 
                        startTime: null, 
                        lastLapTime: 0, 
                        bestTime: 0, 
                        passedLineLastFrame: false,
                        checkpoint1Passed: false,
                        checkpoint2Passed: false,
                        passedCp1: false,
                        passedCp2: false,
                        split1Time: 0,
                        split2Time: 0,
                        laps: 0,
                        finished: false,
                        finishTime: null,
                        lastS1Time: 0,
                        lastS2Time: 0,
                        lastS3Time: 0,
                        bestS1Time: 0,
                        bestS2Time: 0,
                        bestS3Time: 0,
                        prevAlong: null,
                        ready: false,
                        penaltyUntil: 0,
                        blink: false
                    }
                };
                
                if (playerCount === 0 && !room.timer) {
                    room.startTime = Date.now();
                    room.timer = setTimeout(() => {
                        room.started = false;
                        room.raceStarted = false;
                        room.timer = null;
                    }, ROOM_TIMEOUT);
                }
                
                ws.send(JSON.stringify({ type: 'joinedRoom', roomId, playerId, playerCount: Object.keys(room.players).length }));
            }
            
            if (data.type === 'startGame') {
                if (currentRoom !== null && rooms[currentRoom]) {
                    let room = rooms[currentRoom];
                    if (room.phase === 'lobby') {
                        room.phase = 'qualif';
                        room.raceStarted = true;
                        room.started = true;
                        room.qualifStartTime = Date.now();
                        room.bestQualifS1Time = 0;
                        room.bestQualifS2Time = 0;
                        room.bestQualifS3Time = 0;
                        room.readyStartTime = null;
                        if (room.timer) {
                            clearTimeout(room.timer);
                            room.timer = null;
                        }
                        for (let pid in room.players) {
                            let p = room.players[pid];
                            p.race.startTime = Date.now();
                            p.race.laps = 0;
                            p.race.finished = false;
                            p.race.finishTime = null;
                            p.race.bestTime = 0;
                            p.race.passedLineLastFrame = false;
                            p.race.checkpoint1Passed = false;
                            p.race.checkpoint2Passed = false;
                            p.race.passedCp1 = false;
                            p.race.passedCp2 = false;
                            p.race.split1Time = 0;
                            p.race.split2Time = 0;
                            p.race.lastS1Time = 0;
                            p.race.lastS2Time = 0;
                            p.race.lastS3Time = 0;
                            p.race.bestS1Time = 0;
                            p.race.bestS2Time = 0;
                            p.race.bestS3Time = 0;
                            p.race.prevAlong = null;
                            p.race.ready = false;
                            p.race.penaltyUntil = 0;
                            p.race.blink = false;
                            // reset position
                            const idx = Object.keys(room.players).indexOf(pid);
                            const tp = room.trackPoints || DEFAULT_TRACK;
                            const p0 = tp[0];
                            const p1 = tp[1] || tp[0];
                            const dx = p1.x - p0.x;
                            const dy = p1.y - p0.y;
                            const len = Math.hypot(dx, dy) || 1;
                            const nx = -dy / len;
                            const ny = dx / len;
                            p.car.x = p0.x + nx * (idx * 20 - 40) - (dx / len) * 30;
                            p.car.y = p0.y + ny * (idx * 20 - 40) - (dy / len) * 30;
                            p.car.angle = Math.atan2(dx, -dy);
                            p.car.speed = 0;
                        }
                    }
                }
            }
            
            if (data.type === 'leaveRoom') {
                if (currentRoom !== null && rooms[currentRoom]) {
                    let roomId = currentRoom;
                    delete rooms[roomId].players[playerId];
                    currentRoom = null;
                    playerRoom[playerId] = null;
                    if (rooms[roomId] && rooms[roomId].phase === 'ready' && Object.keys(rooms[roomId].players).length > 0 && Object.values(rooms[roomId].players).every(p => p.ready)) {
                        startRacePhase(rooms[roomId]);
                    }
                    if (Object.keys(rooms[roomId].players).length === 0) {
                        rooms[roomId].phase = 'lobby';
                        rooms[roomId].started = false;
                        rooms[roomId].raceStarted = false;
                        rooms[roomId].startTime = null;
                        rooms[roomId].qualifStartTime = null;
                        rooms[roomId].raceStartTime = null;
                        rooms[roomId].winner = null;
                        rooms[roomId].circuit = 'Italian Grand Prix';
                        rooms[roomId].trackPoints = DEFAULT_TRACK;
                        rooms[roomId].roadWidth = 300;
                        rooms[roomId].timer = null;
                        rooms[roomId].bestQualifS1Time = 0;
                        rooms[roomId].bestQualifS2Time = 0;
                        rooms[roomId].bestQualifS3Time = 0;
                        rooms[roomId].readyStartTime = null;
                    }
                }
            }
            
            if (data.type === 'selectCircuit' && currentRoom !== null && rooms[currentRoom]) {
                let room = rooms[currentRoom];
                if (room.phase === 'lobby') {
                    room.circuit = data.circuit || room.circuit;
                    room.trackPoints = tracksData[room.circuit] || DEFAULT_TRACK;
                    room.roadWidth = getRoadWidth(room.circuit);
                }
            }
            
            if (data.type === 'ready' && currentRoom !== null && rooms[currentRoom] && rooms[currentRoom].players[playerId]) {
                let room = rooms[currentRoom];
        if (room.phase === 'ready') {
                    room.players[playerId].ready = true;
                    let allReady = Object.keys(room.players).length > 0 && Object.values(room.players).every(p => p.ready);
                    if (allReady) startRacePhase(room);
                }
            }

            if (data.type === 'input' && currentRoom !== null && rooms[currentRoom] && rooms[currentRoom].players[playerId]) {
                rooms[currentRoom].players[playerId].inputs = data.inputs;
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        console.log(`Joueur déconnecté : ${playerId}`);
        if (currentRoom !== null && rooms[currentRoom]) {
            let roomId = currentRoom;
            delete rooms[roomId].players[playerId];
            if (Object.keys(rooms[roomId].players).length === 0) {
                rooms[roomId].phase = 'lobby';
                rooms[roomId].started = false;
                rooms[roomId].raceStarted = false;
                rooms[roomId].startTime = null;
                rooms[roomId].qualifStartTime = null;
                rooms[roomId].raceStartTime = null;
                rooms[roomId].winner = null;
                rooms[roomId].circuit = 'Italian Grand Prix';
                rooms[roomId].trackPoints = DEFAULT_TRACK;
                rooms[roomId].roadWidth = 300;
                rooms[roomId].timer = null;
            }
        }
        delete playerWs[playerId];
        delete playerRoom[playerId];
    });
});

// Boucle du serveur multijoueur (60 FPS)
setInterval(() => {
    for (let roomId in rooms) {
        let room = rooms[roomId];
        if (!room.raceStarted) continue;
        
        // Transition qualification -> écran prêt après 5 minutes
        if (room.phase === 'qualif' && (Date.now() - room.qualifStartTime) >= room.qualifDuration) {
            room.phase = 'ready';
            room.readyStartTime = Date.now();
        }
        // Transition prêt -> course après 1 minute
        if (room.phase === 'ready' && (Date.now() - room.readyStartTime) >= room.readyDuration) {
            startRacePhase(room);
        }
        if (room.phase === 'lights' && room.lightsOutTime && Date.now() >= room.lightsOutTime) {
            room.phase = 'race';
            room.raceStartTime = Date.now();
            room.lightsStartTime = null;
            room.lightsOutTime = null;
        }
        let players = room.players;
        let trackPts = room.trackPoints || DEFAULT_TRACK;
        let playerIds = Object.keys(players);

        if (room.phase === 'lights') {
            for (let id of playerIds) {
                let p = players[id];
                if (p.inputs && p.inputs.accel && !(p.race.penaltyUntil && p.race.penaltyUntil > Date.now())) {
                    p.race.penaltyUntil = Date.now() + 5000;
                    p.race.blink = true;
                }
            }
            const lightsElapsed = Date.now() - (room.lightsStartTime || Date.now());
            const lightsCount = Math.min(5, Math.floor(lightsElapsed / 1000) + 1);
            const payload = JSON.stringify({ type: 'state', players, leaderboard, raceStarted: room.raceStarted, phase: room.phase, qualifTimeLeft: 0, raceTimeLeft: 0, readyTimeLeft: 0, lightsCount, lightsOutTime: room.lightsOutTime, targetLaps: room.targetLaps, winner: room.winner, circuit: room.circuit, circuitLeaderboards: circuitLeaderboards, bestQualifS1Time: room.bestQualifS1Time || 0, bestQualifS2Time: room.bestQualifS2Time || 0, bestQualifS3Time: room.bestQualifS3Time || 0 });
            for (let pid of playerIds) {
                if (playerWs[pid] && playerWs[pid].readyState === WebSocket.OPEN) playerWs[pid].send(payload);
            }
            continue;
        }

        if (room.phase === 'ready') {
            const readyTimeLeft = Math.max(0, room.readyDuration - (Date.now() - room.readyStartTime));
            const payload = JSON.stringify({ type: 'state', players, leaderboard, raceStarted: room.raceStarted, phase: room.phase, qualifTimeLeft: 0, raceTimeLeft: 0, readyTimeLeft, targetLaps: room.targetLaps, winner: room.winner, circuit: room.circuit, circuitLeaderboards: circuitLeaderboards, bestQualifS1Time: room.bestQualifS1Time || 0, bestQualifS2Time: room.bestQualifS2Time || 0, bestQualifS3Time: room.bestQualifS3Time || 0 });
            for (let pid of playerIds) {
                if (playerWs[pid] && playerWs[pid].readyState === WebSocket.OPEN) playerWs[pid].send(payload);
            }
            continue;
        }
        
        // 1. Mouvement
        for (let id of playerIds) {
            let p = players[id];
            let car = p.car;
            let inputs = p.inputs;

            let penalized = !!(p.race.penaltyUntil && p.race.penaltyUntil > Date.now());
            if (p.race.penaltyUntil && Date.now() >= p.race.penaltyUntil) {
                p.race.penaltyUntil = 0;
                p.race.blink = false;
                penalized = false;
            }
            p.race.blink = penalized;

            let onTrack = isOnTrack(car.x, car.y, trackPts, room.roadWidth);
            let currentMaxSpeed = onTrack ? constants.maxSpeed : (constants.maxSpeed / 5);

            if (!penalized) {
                if (inputs.left) {
                    car.angle -= constants.turnSpeed * Math.max(0.4, Math.min(1.0, Math.abs(car.speed) / 2));
                }
                if (inputs.right) {
                    car.angle += constants.turnSpeed * Math.max(0.4, Math.min(1.0, Math.abs(car.speed) / 2));
                }

                if (inputs.accel) {
                    car.speed += constants.accel;
                    if (car.speed > currentMaxSpeed) car.speed = currentMaxSpeed;
                } else if (inputs.brake) {
                    car.speed -= constants.brake;
                    if (car.speed < -constants.reverseMaxSpeed) car.speed = -constants.reverseMaxSpeed;
                } else {
                    if (car.speed > 0) {
                        car.speed -= constants.friction;
                        if (car.speed < 0) car.speed = 0;
                    } else if (car.speed < 0) {
                        car.speed += constants.friction;
                        if (car.speed > 0) car.speed = 0;
                    }
                }
            } else {
                car.speed = 0;
            }

            if (!onTrack) {
                car.speed *= 0.95;
            }

            car.x += Math.sin(car.angle) * car.speed;
            car.y -= Math.cos(car.angle) * car.speed;
        }

        // 2. Collisions
        for (let i = 0; i < playerIds.length; i++) {
            for (let j = i + 1; j < playerIds.length; j++) {
                let p1 = players[playerIds[i]];
                let p2 = players[playerIds[j]];
                let c1 = p1.car;
                let c2 = p2.car;

                let dx = c2.x - c1.x;
                let dy = c2.y - c1.y;
                let dist = Math.sqrt(dx * dx + dy * dy);
                let minDist = CAR_WIDTH / 2;

                if (dist < minDist && dist > 0) {
                    let overlap = minDist - dist;
                    let nx = dx / dist;
                    let ny = dy / dist;

                    c1.x -= nx * overlap * 0.5;
                    c1.y -= ny * overlap * 0.5;
                    c2.x += nx * overlap * 0.5;
                    c2.y += ny * overlap * 0.5;

                    let tempSpeed = c1.speed;
                    c1.speed = c2.speed * 0.7;
                    c2.speed = tempSpeed * 0.7;
                }
            }
        }

        // 3. Tours
        for (let id of playerIds) {
            let p = players[id];
            let car = p.car;
            let race = p.race;

            const p0 = trackPts[0];
            const p1 = trackPts[1] || trackPts[0];
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const len = Math.hypot(dx, dy) || 1;
            const ndx = dx / len;
            const ndy = dy / len;
            const nx = -ndy;
            const ny = ndx;

            const _ci = checkpointIndices(trackPts);
            const idx1 = _ci[0];
            const idx2 = _ci[1];
            const cp1 = trackPts[idx1];
            const cp2 = trackPts[idx2];

            if (Math.abs(car.x - cp1.x) < 2000 && Math.abs(car.y - cp1.y) < 2000) {
                race.checkpoint1Passed = true;
            }
            if (Math.abs(car.x - cp2.x) < 2000 && Math.abs(car.y - cp2.y) < 2000) {
                race.checkpoint2Passed = true;
            }

            // Temps intermédiaires au passage des checkpoints
            const cp1n = trackPts[(idx1 + 1) % trackPts.length];
            const cp2n = trackPts[(idx2 + 1) % trackPts.length];
            const cdx1 = cp1n.x - cp1.x, cdy1 = cp1n.y - cp1.y;
            const clen1 = Math.hypot(cdx1, cdy1) || 1;
            const cnx1 = -cdy1 / clen1, cny1 = cdx1 / clen1;
            const along1 = (car.x - cp1.x) * (cdx1 / clen1) + (car.y - cp1.y) * (cdy1 / clen1);
            const across1 = (car.x - cp1.x) * cnx1 + (car.y - cp1.y) * cny1;
            const cpThreshold1 = (room.roadWidth || 300) / 2 + 20;
            if (Math.abs(across1) < cpThreshold1 && along1 >= -50 && along1 <= clen1 + 50 && !race.passedCp1) {
                race.passedCp1 = true;
                race.checkpoint1Passed = true;
                if (race.startTime) {
                    race.split1Time = (Date.now() - race.startTime) / 1000;
                    if (!race.bestS1Time || race.split1Time < race.bestS1Time) race.bestS1Time = race.split1Time;
                    if (room.phase === 'qualif' && (!room.bestQualifS1Time || race.split1Time < room.bestQualifS1Time)) room.bestQualifS1Time = race.split1Time;
                }
            }

            const cdx2 = cp2n.x - cp2.x, cdy2 = cp2n.y - cp2.y;
            const clen2 = Math.hypot(cdx2, cdy2) || 1;
            const cnx2 = -cdy2 / clen2, cny2 = cdx2 / clen2;
            const along2 = (car.x - cp2.x) * (cdx2 / clen2) + (car.y - cp2.y) * (cdy2 / clen2);
            const across2 = (car.x - cp2.x) * cnx2 + (car.y - cp2.y) * cny2;
            const cpThreshold2 = (room.roadWidth || 300) / 2 + 20;
            if (Math.abs(across2) < cpThreshold2 && along2 >= -50 && along2 <= clen2 + 50 && !race.passedCp2) {
                race.passedCp2 = true;
                race.checkpoint2Passed = true;
                if (race.startTime) {
                    race.split2Time = (Date.now() - race.startTime) / 1000;
                    let sector2 = race.split2Time - (race.split1Time || 0);
                    if (sector2 > 0 && (!race.bestS2Time || sector2 < race.bestS2Time)) race.bestS2Time = sector2;
                    if (room.phase === 'qualif' && sector2 > 0 && (!room.bestQualifS2Time || sector2 < room.bestQualifS2Time)) room.bestQualifS2Time = sector2;
                }
            }

            // Temps intermédiaires à 33% et 66% de la distance
            const along = (car.x - p0.x) * ndx + (car.y - p0.y) * ndy;
            const across = (car.x - p0.x) * nx + (car.y - p0.y) * ny;
            const prevAlong = (race.prevAlong === undefined) ? null : race.prevAlong;
            let crossedFinish = false;
            if (prevAlong !== null) {
                if ((prevAlong < 0 && along >= 0) || (prevAlong > 0 && along <= 0)) crossedFinish = true;
            }
            race.prevAlong = along;
            const acrossThreshold = (room.roadWidth || 300) / 2 + 40;
            let crossingLine = crossedFinish && Math.abs(across) < acrossThreshold && Math.abs(along) < 500;

            if (crossingLine) {
                let now = Date.now();
                if (!race.startTime) {
                    race.startTime = now;
                    race.checkpoint1Passed = false;
                    race.checkpoint2Passed = false;
                } else if (race.checkpoint1Passed && race.checkpoint2Passed) {
                    let lapDuration = (now - race.startTime) / 1000;
                    race.lastLapTime = lapDuration;
                    race.lastS1Time = race.split1Time || 0;
                    race.lastS2Time = Math.max(0, (race.split2Time || 0) - (race.split1Time || 0));
                    race.lastS3Time = Math.max(0, lapDuration - (race.split2Time || 0));
                    if (race.split1Time > 0 && (!race.bestS1Time || race.split1Time < race.bestS1Time)) race.bestS1Time = race.split1Time;
                    let _s2 = (race.split2Time || 0) - (race.split1Time || 0);
                    if (_s2 > 0 && (!race.bestS2Time || _s2 < race.bestS2Time)) race.bestS2Time = _s2;
                    let _s3 = lapDuration - (race.split2Time || 0);
                    if (_s3 > 0 && (!race.bestS3Time || _s3 < race.bestS3Time)) race.bestS3Time = _s3;
                    if (room.phase === 'qualif') {
                        if (race.split1Time > 0 && (!room.bestQualifS1Time || race.split1Time < room.bestQualifS1Time)) room.bestQualifS1Time = race.split1Time;
                        if (_s2 > 0 && (!room.bestQualifS2Time || _s2 < room.bestQualifS2Time)) room.bestQualifS2Time = _s2;
                        if (_s3 > 0 && (!room.bestQualifS3Time || _s3 < room.bestQualifS3Time)) room.bestQualifS3Time = _s3;
                    }
                    if (!race.bestTime || lapDuration < race.bestTime) {
                        race.bestTime = lapDuration;
                    }
                    race.startTime = now;
                    race.checkpoint1Passed = false;
                    race.checkpoint2Passed = false;

                    if (room.phase === 'race' && !race.finished) {
                        race.laps = (race.laps || 0) + 1;
                        if (race.laps >= room.targetLaps) {
                            race.finished = true;
                            race.finishTime = now;
                            if (!room.winner) {
                                room.winner = p.nickname || 'Pilote';
                                room.phase = 'finished';
                            }
                        }
                    }

                    let nickname = p.nickname || 'Pilote';
                    let playerId = p.id || id;
                    let circuit = room.circuit || 'Inconnu';
                    let date = new Date().toISOString().slice(0, 10);
                    let existing = leaderboard.find(e => e.nickname === nickname && e.circuit === circuit);
                    if (existing) {
                        if (lapDuration < existing.time) {
                            existing.time = lapDuration;
                            existing.nickname = nickname;
                            existing.date = date;
                        }
                    } else {
                        leaderboard.push({ id: playerId, nickname, time: lapDuration, circuit, date });
                    }
                    leaderboard.sort((a, b) => a.time - b.time);
                    if (leaderboard.length > 10) {
                        leaderboard = leaderboard.slice(0, 10);
                    }
                    saveLeaderboard();

                    // Meilleurs temps par circuit
                    circuit = room.circuit || 'Inconnu';
                    if (!circuitLeaderboards[circuit]) circuitLeaderboards[circuit] = [];
                    let cexisting = circuitLeaderboards[circuit].find(e => e.nickname === nickname);
                    if (cexisting) {
                        if (lapDuration < cexisting.time) {
                            cexisting.time = lapDuration;
                            cexisting.nickname = nickname;
                            cexisting.id = playerId;
                        }
                    } else {
                        circuitLeaderboards[circuit].push({ id: playerId, nickname, time: lapDuration });
                    }
                    circuitLeaderboards[circuit].sort((a, b) => a.time - b.time);
                    if (circuitLeaderboards[circuit].length > 10) {
                        circuitLeaderboards[circuit] = circuitLeaderboards[circuit].slice(0, 10);
                    }
                    saveCircuitLeaderboards();
                }
                race.checkpoint1Passed = false;
                race.checkpoint2Passed = false;
                race.split1Time = 0;
                race.split2Time = 0;
                race.passedCp1 = false;
                race.passedCp2 = false;
                race.passedLineLastFrame = true;
            } else if (!crossingLine) {
                race.passedLineLastFrame = false;
            }

            p.currentLapTime = race.startTime ? ((Date.now() - race.startTime) / 1000).toFixed(2) : '0.00';
            p.onTrack = isOnTrack(car.x, car.y, trackPts, room.roadWidth);
            p.speedKmh = Math.round(Math.abs(car.speed) * 10);
        }

        // Diffuser l'état de cette salle aux joueurs de cette salle
const qualifTimeLeft = room.phase === 'qualif' ? Math.max(0, room.qualifDuration - (Date.now() - room.qualifStartTime)) : 0;
const raceTimeLeft = room.phase === 'race' ? (Date.now() - room.raceStartTime) : 0;
const readyTimeLeft = room.phase === 'ready' ? Math.max(0, room.readyDuration - (Date.now() - room.readyStartTime)) : 0;
const payload = JSON.stringify({ type: 'state', players, leaderboard, raceStarted: room.raceStarted, phase: room.phase, qualifTimeLeft, raceTimeLeft, readyTimeLeft, lightsCount: room.phase === 'lights' ? 5 : (room.lightsOutTime ? 5 : 0), lightsOutTime: room.lightsOutTime, targetLaps: room.targetLaps, winner: room.winner, circuit: room.circuit, circuitLeaderboards: circuitLeaderboards, bestQualifS1Time: room.bestQualifS1Time || 0, bestQualifS2Time: room.bestQualifS2Time || 0, bestQualifS3Time: room.bestQualifS3Time || 0 });
        for (let pid of playerIds) {
            if (playerWs[pid] && playerWs[pid].readyState === WebSocket.OPEN) {
                playerWs[pid].send(payload);
            }
        }
    }
}, 1000 / 60);

// Envoyer la liste des salles à tous les clients (pour l'écran de choix)
setInterval(() => {
    let roomList = [];
    for (let i = 0; i < ROOM_COUNT; i++) {
        let room = rooms[i];
        let players = Object.values(room.players).map(p => p.nickname || 'Pilote');
        let status = 'vide';
        if (room.raceStarted) {
            status = 'en course';
        } else if (players.length > 0) {
            status = 'en attente';
        }
        let timeLeft = room.startTime ? Math.max(0, ROOM_TIMEOUT - (Date.now() - room.startTime)) : ROOM_TIMEOUT;
        roomList.push({
            id: i,
            count: players.length,
            players: players,
            raceStarted: room.raceStarted,
            status: status,
            timeLeft: Math.ceil(timeLeft / 1000)
        });
    }
    
    const payload = JSON.stringify({ type: 'roomList', rooms: roomList, circuitLeaderboards: circuitLeaderboards });
    for (let pid in playerWs) {
        if (playerWs[pid] && playerWs[pid].readyState === WebSocket.OPEN) {
            playerWs[pid].send(payload);
        }
    }
}, 2000);

// Envoyer l'état de la salle d'attente
setInterval(() => {
    for (let roomId in rooms) {
        let room = rooms[roomId];
        if (room.raceStarted) continue;
        
        let players = room.players;
        let playerIds = Object.keys(players);
        let timeLeft = room.startTime ? Math.max(0, ROOM_TIMEOUT - (Date.now() - room.startTime)) : ROOM_TIMEOUT;
        
        const payload = JSON.stringify({ 
            type: 'lobby', 
            roomId, 
            players: Object.values(players).map(p => ({ id: p.id, nickname: p.nickname })),
            circuit: room.circuit,
            timeLeft: Math.ceil(timeLeft / 1000),
            leaderboard
        });
        
        for (let pid of playerIds) {
            if (playerWs[pid] && playerWs[pid].readyState === WebSocket.OPEN) {
                playerWs[pid].send(payload);
            }
        }
    }
}, 1000);

let serverConfig = { port: 3000, host: 'localhost' };
try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'www', 'config.json'), 'utf8'));
    if (cfg && cfg.port) serverConfig.port = cfg.port;
    if (cfg && cfg.host) serverConfig.host = cfg.host;
} catch (e) {}
server.listen(serverConfig.port, serverConfig.host, () => {
    console.log(`Serveur multijoueur avec salles démarré sur http://${serverConfig.host}:${serverConfig.port}`);
});





