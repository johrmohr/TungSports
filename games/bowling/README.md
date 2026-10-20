# Krishiv Bowling

Ten-pin bowling in the browser for 1–4 players, where each player's **phone is the remote**. The TV (or laptop) shows the 3D alley; everyone scans one QR code, and their phone becomes their remote: hold **B**, swing your arm, lift your thumb to bowl, twist your wrist to curve the ball.

Built the same way as Krishiv Kart: a small Node server, Socket.IO, a self-signed HTTPS page for the phones (motion sensors require HTTPS), and server-generated QR codes. Everything you see and hear is generated in code — no image, model or audio files.

Krishiv Bowling is also one of the games on the **Krishiv Sports** menu: picking Bowling there starts this server for you (ports 3100 / 3543) and sends the TV and the phones here, and the ⌂ Krishiv Sports button brings everyone back.

## Run it

```bash
npm install
npm start
```

Open **http://localhost:3000** on the computer connected to the TV. Phones must be on the **same Wi-Fi**.

1. Each player scans the QR code on the TV (one code for everyone; players get P1–P4 in the order they join).
2. The first time, the phone warns about the certificate (it is this computer's own local certificate):
   - **iPhone:** *Show Details* → *visit this website* → *Visit Website*
   - **Android:** *Advanced* → *Proceed*
3. Enter a name, pick a character, a ball colour and your bowling hand, tap **Join game** (iPhone then asks for *Motion & Orientation* — tap **Allow**).
4. Player 1 taps **Start game** on their phone (or press **Enter** on the computer).

Click or press a key on the TV page once so the browser allows sound.

> Krishiv Sports and Krishiv Kart use the same ports (3000 / 3443) when started on their own. Stop them first, or run `PORT=3100 HTTPS_PORT=3543 npm start` (the ports Krishiv Sports uses for Bowling, so its menu picks up this server too). This project shares its local certificate with Krishiv Sports, so phones that already accepted it there may not be asked again.

## How to bowl

| Action | Phone | Keyboard (TV) |
|---|---|---|
| Move where you stand | ◀ ▶ | ← → |
| Switch between **Move** and **Turn** (aim) | **A** | A or Enter |
| Zoom toward the pins | ▲ Zoom | ↑ |
| Swing back and forward and let go to roll | Hold the blue **B** area, swing, **lift your thumb** | Hold Space (power meter), ← → to curve, release |
| Curve the ball | Twist your wrist as you let go | ← → while holding Space |
| Pause | **+** | Esc / P |

- **Hold the phone like a remote control**: screen up, top pointing at the TV, thumb on B. Grip it with your whole hand — you bowl by lifting your thumb, never by letting go of the phone.
- Holding B starts the four-step approach; your bowler waits at the foul line if you are still holding.
- **How hard you swing sets the ball speed** — from about 8 mph for a soft swing to about 24 mph for a hard one.
- **Where you let go matters.** The sweet spot is the bottom of the swing (from a little before your leg to a little after). Outside it, the further off you are, the worse the throw:
  - **Early** (arm still coming down behind you): the ball is dumped — slower, lands hard and is pushed off your line (outward).
  - **Late** (arm already on the way up): the ball is lofted — it flies and bounces, hooks less and is pulled across your body.
  - **During the backswing:** the ball rolls backwards into the crowd (you throw again).
  - After each throw the phone shows a **release meter** (where you let go on the swing arc) and the TV shows your speed and release.
- Twisting counter-clockwise (a right-hander's hook) curves the ball left; clockwise curves right. *Invert curve direction* is in the phone's ⚙ settings.
- Full power comes from a comfortable swing — swinging harder adds nothing.
- No motion sensors (or permission denied)? The phone switches to **touch flick**: drag the ball up and let go; curve by bending the flick at the end.

## What's in it

- **Real pin action**: Rapier rigid-body physics with USBC-regulation lane, pin and ball dimensions, pin mass/centre of gravity/inertia, ball–pin restitution 0.67, an oil-pattern hook model (skid on the oil, break on the dry back end), gutters, kickbacks and the pit. Pocket hits strike, head-on hits leave splits, light hits leave the 10 pin.
- **Official scoring**: strikes, spares, the 10th frame's bonus balls, pending totals, split marks (USBC rule 2h), and streak names (Double, Turkey, Fourth … Perfect).
- **Brainrot Edition**: every player bowls as a Brainrot character (Tung Tung Tung Sahur is the main one), picked on the phone or on the TV lobby cards.
- **TV presentation**: turn intro facing your character, a ghosted bowler in the aiming view with the red dotted guide, pin indicator and mini scorecard, chase camera, metallic *Strike* banner, the blue/black scorecard with bow-tie strikes and triangle spares, the pinsetter (lift → sweep → re-set), a cheering / groaning / laughing crowd, mirror-glossy lanes.
- **Multiplayer**: 1–4 players, turns frame by frame. Phones show whose turn it is, the scores, and their own result. A phone that reloads or loses Wi-Fi gets its slot back. Players without a phone can be added in the lobby and use the keyboard.

## Tests

```bash
npm test                       # scoring (87), swing detection (64), release model (7), server protocol (17)
npm run test:physics           # pin-action strike rates, hook paths, gutters, rack stability
npm run test:e2e               # TV + 4 headless phones: join, D-pad, real gyro swings, reload, full game, results
npm run tour                   # screenshots of every stage into ./screenshots
```

Browser tests use Google Chrome at its standard macOS path (`CHROME_PATH` overrides it). Real-device swing feel still deserves a hands-on test with your phones.

## Layout

```
server.js                 HTTP (TV) + HTTPS (phones) + Socket.IO rooms, QR codes, validation
public/index.html         TV page             public/remote.html   phone remote
public/js/shared/         protocol.js · scoring.js (rules) · physics.js (Rapier lane / pins / ball)
public/js/display/        main.js (game flow) · scene.js · avatar.js (characters) · camera.js · hud.js · lobby.js · audio.js · textures.js · net.js
public/js/remote/         remote.js (phone UI + network) · swing.js (motion → speed / spin / release)
tools/                    tests, physics tuning, e2e, screenshot tour
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Phone can't open the page | Same Wi-Fi (not a guest network). Allow `node` when macOS asks about incoming connections. With several networks, `PAD_HOST=<ip> npm start`. |
| Swinging does nothing on iPhone | Reload, tap **Join**, and allow Motion & Orientation. If you tapped *Don't Allow*, close Safari completely and reopen the page. Touch flick works meanwhile. |
| Ball curves the wrong way | Phone ⚙ → *Invert curve direction*. |
| No sound on the TV | Click the TV page or press a key once. **M** mutes. |
