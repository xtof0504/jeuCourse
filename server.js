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

let gameState = {
    car: { x: 500, y: 700, angle: 0, speed: 0 },
    inputs: { left: false, right: false, accel: false, brake: false }
};

const constants = {
    maxSpeed: 8,
    reverseMaxSpeed: 3,
    accel: 0.15,
    friction: 0.05,
    brake: 0.3,
    turnSpeed: 0.04
};

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

    if (inputs.left) {
        car.angle -= constants.turnSpeed * Math.max(0.4, Math.min(1.0, Math.abs(car.speed) / 2));
    }
    if (inputs.right) {
        car.angle += constants.turnSpeed * Math.max(0.4, Math.min(1.0, Math.abs(car.speed) / 2));
    }

    if (inputs.accel) {
        car.speed += constants.accel;
        if (car.speed > constants.maxSpeed) car.speed = constants.maxSpeed;
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

    car.x += Math.sin(car.angle) * car.speed;
    car.y -= Math.cos(car.angle) * car.speed;

    const payload = JSON.stringify({ type: 'state', car, speed: Math.round(Math.abs(car.speed) * 20) });
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}, 1000 / 60);

server.listen(3000, () => {
    console.log('Serveur Windows (Monza) démarré sur http://localhost:3000');
});
