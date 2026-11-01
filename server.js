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

function saveLeaderboard() {
    try {
        fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2), 'utf8');
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
        raceStartTime: null,
        targetLaps: 10,
        winner: null,
        timer: null
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
                const p0 = tp[0];
                const p1 = tp[1] || tp[0];
                const dx = p1.x - p0.x;
                const dy = p1.y - p0.y;
                const len = Math.hypot(dx, dy) || 1;
                const nx = -dy / len;
                const ny = dx / len;
                const startX = p0.x + nx * (playerCount * 20 - 40);
                const startY = p0.y + ny * (playerCount * 20 - 40);
                const startAngle = Math.atan2(dx, -dy); // adjust? car angle 0 points up, movement (sin, -cos). For direction (dx,dy), angle = atan2(dx, -dy). Good.
                
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
                        checkpointPassed: false,
                        laps: 0,
                        finished: false,
                        finishTime: null
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
                            p.race.checkpointPassed = false;
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
                            p.car.x = p0.x + nx * (idx * 20 - 40);
                            p.car.y = p0.y + ny * (idx * 20 - 40);
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
            }
            
            if (data.type === 'selectCircuit' && currentRoom !== null && rooms[currentRoom]) {
                let room = rooms[currentRoom];
                if (room.phase === 'lobby') {
                    room.circuit = data.circuit || room.circuit;
                    room.trackPoints = tracksData[room.circuit] || DEFAULT_TRACK;
                    room.roadWidth = getRoadWidth(room.circuit);
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
        
        // Transition qualification -> course après 5 minutes
        if (room.phase === 'qualif' && (Date.now() - room.qualifStartTime) >= room.qualifDuration) {
            // grilles de départ selon meilleurs temps de qualif
            let sorted = Object.values(room.players).sort((a, b) => {
                let ta = a.race.bestTime || Infinity;
                let tb = b.race.bestTime || Infinity;
                return ta - tb;
            });
            sorted.forEach((p, idx) => {
                const tp = room.trackPoints || DEFAULT_TRACK;
                const p0 = tp[0];
                const p1 = tp[1] || tp[0];
                const dx = p1.x - p0.x;
                const dy = p1.y - p0.y;
                const len = Math.hypot(dx, dy) || 1;
                const nx = -dy / len;
                const ny = dx / len;
                p.car.x = p0.x + nx * (idx * 20 - 40);
                p.car.y = p0.y + ny * (idx * 20 - 40);
                p.car.angle = Math.atan2(dx, -dy);
                p.car.speed = 0;
                p.race.laps = 0;
                p.race.finished = false;
                p.race.finishTime = null;
                p.race.passedLineLastFrame = false;
                p.race.checkpointPassed = false;
                p.race.startTime = Date.now();
            });
            room.phase = 'race';
            room.raceStartTime = Date.now();
        }
        let players = room.players;
        let trackPts = room.trackPoints || DEFAULT_TRACK;
        let playerIds = Object.keys(players);
        
        // 1. Mouvement
        for (let id of playerIds) {
            let p = players[id];
            let car = p.car;
            let inputs = p.inputs;

            let onTrack = isOnTrack(car.x, car.y, trackPts, room.roadWidth);
            let currentMaxSpeed = onTrack ? constants.maxSpeed : (constants.maxSpeed / 5);

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

            let cpX = trackPts[Math.floor(trackPts.length / 2)].x;
            let cpY = trackPts[Math.floor(trackPts.length / 2)].y;
            let inCheckpoint = (Math.abs(car.x - cpX) < 400 && Math.abs(car.y - cpY) < 400);

            if (inCheckpoint) {
                race.checkpointPassed = true;
            }

            const along = (car.x - p0.x) * ndx + (car.y - p0.y) * ndy;
            const across = (car.x - p0.x) * nx + (car.y - p0.y) * ny;
            let crossingLine = (Math.abs(across) < 15 && Math.abs(along) < 150);

            if (crossingLine && !race.passedLineLastFrame) {
                let now = Date.now();
                if (!race.startTime) {
                    race.startTime = now;
                    race.checkpointPassed = false;
                } else if (race.checkpointPassed) {
                    let lapDuration = (now - race.startTime) / 1000;
                    race.lastLapTime = lapDuration;
                    if (!race.bestTime || lapDuration < race.bestTime) {
                        race.bestTime = lapDuration;
                    }
                    race.startTime = now;
                    race.checkpointPassed = false;

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
                    let existing = leaderboard.find(e => (e.id && e.id === playerId) || (!e.id && e.nickname === nickname));
                    if (existing) {
                        if (lapDuration < existing.time) {
                            existing.time = lapDuration;
                            existing.nickname = nickname;
                            existing.id = playerId;
                        }
                    } else {
                        leaderboard.push({ id: playerId, nickname, time: lapDuration });
                    }
                    leaderboard.sort((a, b) => a.time - b.time);
                    if (leaderboard.length > 10) {
                        leaderboard = leaderboard.slice(0, 10);
                    }
                    saveLeaderboard();
                }
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
        const payload = JSON.stringify({ type: 'state', players, leaderboard, raceStarted: room.raceStarted, phase: room.phase, qualifTimeLeft, raceTimeLeft, targetLaps: room.targetLaps, winner: room.winner, circuit: room.circuit });
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
    
    const payload = JSON.stringify({ type: 'roomList', rooms: roomList });
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

server.listen(3000, 'localhost', () => {
    console.log('Serveur multijoueur avec salles démarré sur http://localhost:3000');
});
