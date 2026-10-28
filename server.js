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

let gameState = {
    car: { x: 500 * scale, y: 700 * scale, angle: Math.PI / 2, speed: 0 },
    inputs: { left: false, right: false, accel: false, brake: false }
};

const constants = {
    maxSpeed: 20,          // 20 * 10 = 200 km/h max
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
    console.log('Client Android connecté !');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'input') {
                gameState.inputs = data.inputs;
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        console.log('Client déconnecté');
    });
});

setInterval(() => {
    let car = gameState.car;
    let inputs = gameState.inputs;

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

    const payload = JSON.stringify({ type: 'state', car, speed: Math.round(Math.abs(car.speed) * 10), onTrack });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 1000 / 60);

server.listen(3000, () => {
    console.log('Serveur Windows (Monza) démarré sur http://localhost:3000');
});
