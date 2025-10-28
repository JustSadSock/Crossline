# Crossline

A real-time multiplayer browser-based shooter game built with Node.js and WebSockets.

## Features

- **Real-time Multiplayer**: Play with other players in real-time using WebSocket connections
- **Smooth Gameplay**: Client-side prediction with server-side validation
- **Simple Controls**: WASD for movement, mouse for aiming, click to shoot
- **Health System**: Players have 100 HP and take damage when hit
- **Respawn System**: Players can respawn after being eliminated
- **Visual Feedback**: Health bars, score tracking, and smooth animations

## Technology Stack

### Server-side
- **Node.js**: Runtime environment
- **WebSocket (ws)**: Real-time bidirectional communication
- **HTTP Server**: Serves static files and game client

### Client-side
- **HTML5 Canvas**: Game rendering
- **JavaScript**: Game logic and networking
- **CSS3**: UI styling with gradients and animations

## Project Structure

```
Crossline/
├── server/
│   └── index.js          # Server-side game logic and WebSocket handling
├── public/
│   ├── index.html        # Main HTML page
│   ├── css/
│   │   └── style.css     # Game styling
│   └── js/
│       └── game.js       # Client-side game logic
├── package.json          # Project dependencies
└── README.md            # Documentation
```

## Installation

1. Clone the repository:
```bash
git clone https://github.com/JustSadSock/Crossline.git
cd Crossline
```

2. Install dependencies:
```bash
npm install
```

## Running the Game

### On Windows with ngrok

For easy setup with ngrok tunneling (recommended for multiplayer):
```bash
start-server.bat
```

This will:
- Install dependencies
- Start the Node.js server on port 80 (or 3000 if admin rights not available)
- Start ngrok tunnel for external access
- Open console windows showing server and ngrok output

**Note:** Edit `start-server.bat` to set your ngrok.exe path before running.

### Manual Start

Start the server:
```bash
npm start
```

The game will be available at `http://localhost:3000`

For development with auto-reload:
```bash
npm run dev
```

### Deploying to Static Hosts (Netlify, GitHub Pages, etc.)

If you want to deploy the frontend to a static hosting service while running the server separately:

1. **Start the server locally or on a cloud provider**:
   ```bash
   npm start
   ```

2. **Create a public tunnel with ngrok** (for local servers):
   ```bash
   ngrok http 3000
   ```
   Note the public URL (e.g., `https://abc123.ngrok.io`)

3. **Configure the frontend**:
   - Open the deployed site (e.g., `https://your-site.netlify.app`)
   - In the "URL Сервера" (Server URL) field, enter your ngrok or cloud server URL
   - The URL will be saved automatically in your browser

4. **Alternative: Set via JavaScript**:
   Before the page loads, you can set the server URL in the browser console or via a script:
   ```javascript
   window.CROSSLINE_API_URL = 'https://your-server-url.ngrok.io';
   ```

## How to Play

### Controls
- **W, A, S, D**: Move your player
- **Mouse**: Aim your weapon
- **Left Click**: Shoot
- **Respawn Button**: Respawn after death

### Gameplay
1. Open the game in your browser at `http://localhost:3000`
2. You'll spawn as a green circle (other players are red)
3. Move around using WASD keys
4. Aim with your mouse and click to shoot
5. Hit other players to damage them
6. Avoid getting hit to stay alive
7. When eliminated, click "Respawn" to continue playing

### Game Mechanics
- **Health**: Each player starts with 100 HP
- **Damage**: Each bullet hit deals 20 damage
- **Respawn**: Players respawn at random positions with full health
- **Collision Detection**: Server-side bullet collision with players

## Server Configuration

The server can be configured using environment variables:

- `PORT`: Server port (default: 3000)

Example:
```bash
PORT=8080 npm start
```

## Game State Management

### Server-side
- Maintains authoritative game state
- Updates at 30 FPS
- Handles player connections and disconnections
- Validates player actions
- Manages bullet physics and collisions
- Broadcasts game state to all clients

### Client-side
- Renders game at 60 FPS
- Sends player inputs to server
- Receives and displays game state
- Provides visual feedback (health bars, crosshair, etc.)

## Network Protocol

All messages are sent as JSON over WebSocket:

### Client to Server
```javascript
// Move player
{ type: 'move', x: number, y: number, angle: number }

// Shoot bullet
{ type: 'shoot' }

// Respawn after death
{ type: 'respawn' }
```

### Server to Client
```javascript
// Initial connection
{ type: 'init', playerId: string }

// Game state update
{
  type: 'gameState',
  players: { [id]: { x, y, angle, health, alive, score } },
  bullets: [{ id, x, y, angle, playerId }]
}
```

## Future Enhancements

Potential features for future development:
- Different weapon types
- Power-ups and collectibles
- Team-based gameplay
- Leaderboard system
- Game rooms/lobbies
- Player customization
- Sound effects and music
- Mobile touch controls
- Performance optimizations
- Anti-cheat mechanisms

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

ISC