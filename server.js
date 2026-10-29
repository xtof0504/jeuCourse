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

let rooms = {};
let playerWs = {}; // playerId -> ws
let playerRoom = {}; // playerId -> roomId

for (let i = 0; i < ROOM_COUNT; i++) {
    rooms[i] = {
        id: i,
        players: {},
        started: false,
        raceStarted: false,
        startTime: null,
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

const baseMonzaPoints = [
    {x: 500, y: 700}, {x: 1200, y: 700}, {x: 1500, y: 600}, 
    {x: 1600, y: 300}, {x: 1300, y: 150}, {x: 900, y: 150},
    {x: 700, y: 250}, {x: 500, y: 350}, {x: 300, y: 250},
    {x: 200, y: 400}, {x: 200, y: 600}
];

const monzaPoints = baseMonzaPoints.map(p => ({ x: p.x * scale, y: p.y * scale }));

function isOnTrack(x, y) {
    const roadWidth = 300;
    const halfWidth = roadWidth / 2;

    for (let i = 0; i < monzaPoints.length; i++) {
        let p1 = monzaPoints[i];
        let p2 = monzaPoints[(i + 1) % monzaPoints.length];

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

wss.on('connection', (ws) => {
    const playerId = 'player_' + Math.random().toString(36).substr(2, 9);
    console.log(`Joueur connecté : ${playerId}`);
    playerWs[playerId] = ws;

    let currentRoom = null;
    let nickname = 'Pilote';

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'join') {
                nickname = data.nickname || 'Pilote';
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
                
                const startX = (500 - 40 - (playerCount * 20)) * scale;
                const startY = 700 * scale;
                
                room.players[playerId] = {
                    id: playerId,
                    nickname: nickname,
                    car: { x: startX, y: startY, angle: Math.PI / 2, speed: 0 },
                    inputs: { left: false, right: false, accel: false, brake: false },
                    race: { 
                        startTime: null, 
                        lastLapTime: 0, 
                        bestTime: 0, 
                        passedLineLastFrame: false,
                        checkpointPassed: false
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
                
                ws.send(JSON.stringify({ type: 'joinedRoom', roomId, playerCount: Object.keys(room.players).length }));
            }
            
            if (data.type === 'startGame') {
                if (currentRoom !== null && rooms[currentRoom]) {
                    let room = rooms[currentRoom];
                    if (!room.raceStarted) {
                        room.raceStarted = true;
                        room.started = true;
                        if (room.timer) {
                            clearTimeout(room.timer);
                            room.timer = null;
                        }
                        for (let pid in room.players) {
                            room.players[pid].race.startTime = Date.now();
                        }
                    }
                }
            }
            
            if (data.type === 'leaveRoom') {
                if (currentRoom !== null && rooms[currentRoom]) {
                    delete rooms[currentRoom].players[playerId];
                    currentRoom = null;
                    playerRoom[playerId] = null;
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
            delete rooms[currentRoom].players[playerId];
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
        
        let players = room.players;
        let playerIds = Object.keys(players);
        
        // 1. Mouvement
        for (let id of playerIds) {
            let p = players[id];
            let car = p.car;
            let inputs = p.inputs;

            let onTrack = isOnTrack(car.x, car.y);
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
                let minDist = CAR_WIDTH;

                if (dist < minDist) {
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

            let lineX = monzaPoints[0].x;
            let lineY1 = monzaPoints[0].y - 150;
            let lineY2 = monzaPoints[0].y + 150;

            let cpX = monzaPoints[5].x;
            let cpY = monzaPoints[5].y;
            let inCheckpoint = (Math.abs(car.x - cpX) < 400 && Math.abs(car.y - cpY) < 400);

            if (inCheckpoint) {
                race.checkpointPassed = true;
            }

            let crossingLine = (car.x >= lineX - 15 && car.x <= lineX + 15 && car.y >= lineY1 && car.y <= lineY2);

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

                    let nickname = p.nickname || 'Pilote';
                    let existing = leaderboard.find(e => e.nickname === nickname);
                    if (existing) {
                        if (lapDuration < existing.time) {
                            existing.time = lapDuration;
                        }
                    } else {
                        leaderboard.push({ nickname, time: lapDuration });
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
            p.onTrack = isOnTrack(car.x, car.y);
            p.speedKmh = Math.round(Math.abs(car.speed) * 10);
        }

        // Diffuser l'état de cette salle aux joueurs de cette salle
        const payload = JSON.stringify({ type: 'state', players, leaderboard, raceStarted: room.raceStarted });
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
