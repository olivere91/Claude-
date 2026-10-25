# Sink the Fleet

A two-player naval battle game for the browser. Hide five ships on a 10 × 10 grid, take turns calling shots, and sink the other fleet first.

- **Play online:** one player starts a game and sends the other a link or a 4-letter code. Each of you plays on your own phone or computer.
- **Pass and play:** share one device. A cover screen hides each fleet while you hand it over.
- **Cluster bomb:** sink two ships in a row without a miss to earn one. It hits a 3 × 3 block of squares in a single turn.
- **Battle recap:** at the end, both fleets are uncovered with every shot, accuracy, best hit streak and the order ships went down.
- **Leaderboard:** wins, losses, win %, accuracy, ships sunk, fastest win and current streak for every finished online game.
- **Sound and music:** cannon fire, splashes, explosions and a sea-shanty loop, all generated in the browser. Both can be switched off.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer. There's nothing to install.

```sh
node server.js
```

Then open http://localhost:3000. To play against someone on the same Wi-Fi, they can open `http://<your computer's IP address>:3000`.

## Put it online

The game needs a small always-on server, so it can't run on GitHub Pages, which only hosts static files.

### Render (free to start)

1. Sign in at [render.com](https://render.com) with your GitHub account.
2. Open https://render.com/deploy?repo=https://github.com/olivere91/Claude- and click **Apply**. Render reads `render.yaml` and sets everything up.
3. When the deploy finishes, Render gives you a web address like `https://sink-the-fleet.onrender.com`. Share that.

On Render's free plan:

- The server goes to sleep after about 15 minutes without visitors. The first visit after that takes up to a minute to load.
- There's no permanent storage, so **the leaderboard resets whenever the server restarts or sleeps**, and any game in progress is lost. To keep the leaderboard, move to a paid plan and add a disk: the steps are commented in `render.yaml`.

### Anywhere that runs Docker

```sh
docker build -t sink-the-fleet .
docker run -p 3000:3000 -v sink-the-fleet-data:/data sink-the-fleet
```

The `-v` volume keeps the leaderboard between restarts.

### Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on |
| `DATA_DIR` | `./data` | Folder where the leaderboard (`results.json`) is saved |

## How it works

- `server.js` is a single Node file with no dependencies. It serves the page, keeps each game in memory, and sends live updates to both players with Server-Sent Events.
- The server holds both fleets and answers every shot itself, so neither player's browser ever receives the other fleet until the game is over. It also checks every move: turn order, valid fleets, and whether a cluster bomb has really been earned.
- `public/rules.js` holds the game rules. The browser and the server load the same file, so they always agree.
- `public/index.html` is the whole game page.
- Games that nobody has touched for a day are cleared out. Finished online games are saved to `data/results.json` for the leaderboard (the newest 5,000 are kept).

### Limits worth knowing

- There are no accounts. Captains on the leaderboard are matched by the name they type, so anyone can play under any name.
- Games in progress live in memory and are lost if the server restarts.
- Pass-and-play games aren't counted on the leaderboard, because nothing checks who really played them.
