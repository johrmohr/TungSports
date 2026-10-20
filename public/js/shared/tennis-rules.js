// Tennis scoring for Krishiv Sports: always doubles, a match is 1 game, best
// of 3 or best of 5 games (no sets). Pure: shared by the TV and the tests.
//
//   const m = new TennisMatch({ format: 3 });
//   m.server            → { team, member } serving this game
//   m.side              → 'deuce' | 'ad'  (which court the next serve goes to)
//   m.receiver          → { team, member } receiving the next serve
//   m.point(team)       → result of the rally: { call, game, match, … }
//   m.pointLabel(team)  → '0' | '15' | '30' | '40' | 'Ad'
//   m.situation()       → 'match point' | 'game point' | 'break point' | 'deuce' | null
//
// Serving: the serve passes to the other team after every game and the
// partners take turns (A1, B1, A2, B2, …). In the receiving team one player
// takes the deuce court and the other the ad court, so they alternate every
// point; whoever receives plays back, the partner plays at the net.

const LABELS = ['0', '15', '30', '40'];

export class TennisMatch {
  constructor({ format = 3, firstTeam = 0 } = {}) {
    this.format = [1, 3, 5].includes(format) ? format : 3;
    this.gamesToWin = Math.ceil(this.format / 2);
    this.points = [0, 0];
    this.games = [0, 0];
    this.firstTeam = firstTeam === 1 ? 1 : 0;
    this.gameIndex = 0;
    this.winner = null;
    this.history = [];            // [{ gameIndex, winner, server }]
    this.pointsPlayed = 0;
    this.totalPoints = [0, 0];
  }

  get over() { return this.winner !== null; }

  // A1 B1 A2 B2 A1 …
  serverOf(gameIndex) {
    const team = (this.firstTeam + gameIndex) % 2;
    const member = Math.floor(gameIndex / 2) % 2;
    return { team, member };
  }

  get server() { return this.serverOf(this.gameIndex); }
  get receivingTeam() { return 1 - this.server.team; }

  // Points played in the current game decide the court.
  get side() { return (this.points[0] + this.points[1]) % 2 === 0 ? 'deuce' : 'ad'; }

  // Member 0 of the receiving team takes the deuce court in the team's first
  // receiving game; partners swap courts on their next receiving game so both
  // get the deuce side over a long match.
  get receiver() {
    const team = this.receivingTeam;
    const receivingGames = Math.floor(this.gameIndex / 2);
    const deuceMember = receivingGames % 2;
    return { team, member: this.side === 'deuce' ? deuceMember : 1 - deuceMember };
  }

  pointLabel(team) {
    const [a, b] = [this.points[team], this.points[1 - team]];
    if (a >= 3 && b >= 3) {
      if (a === b) return '40';
      return a > b ? 'Ad' : '40';
    }
    return LABELS[Math.min(3, a)];
  }

  isDeuce() { return this.points[0] >= 3 && this.points[0] === this.points[1]; }
  advantage() {
    const [a, b] = this.points;
    if (a >= 3 && b >= 3 && a !== b) return a > b ? 0 : 1;
    return null;
  }

  // Would winning the next point win the game for `team`?
  gamePointFor(team) {
    const a = this.points[team], b = this.points[1 - team];
    return a >= 3 && a - b >= 1;
  }

  // The call for the coming point (shown before the serve).
  situation() {
    if (this.over) return null;
    for (const team of [0, 1]) {
      if (this.gamePointFor(team) && this.games[team] + 1 >= this.gamesToWin) return { kind: 'match point', team };
    }
    for (const team of [0, 1]) {
      if (this.gamePointFor(team)) return { kind: team === this.server.team ? 'game point' : 'break point', team };
    }
    if (this.isDeuce()) return { kind: 'deuce', team: null };
    return null;
  }

  // The score as the umpire calls it after a point (server's score first).
  call() {
    const s = this.server.team;
    const adv = this.advantage();
    if (this.isDeuce()) return 'Deuce';
    if (adv !== null) return 'Advantage';
    const a = this.points[s], b = this.points[1 - s];
    if (a === b) return a === 0 ? 'Love all' : `${LABELS[a]} all`;
    const word = (n) => (n === 0 ? 'Love' : LABELS[n]);
    return `${word(a)}–${word(b)}`;
  }

  // `team` won the rally.
  point(team) {
    if (this.over) return { call: null, game: null, match: null };
    const servedBy = this.server;
    this.points[team]++;
    this.pointsPlayed++;
    this.totalPoints[team]++;
    const a = this.points[team], b = this.points[1 - team];
    if (a >= 4 && a - b >= 2) {
      this.games[team]++;
      this.history.push({ gameIndex: this.gameIndex, winner: team, server: servedBy });
      const broke = team !== servedBy.team;
      this.points = [0, 0];
      if (this.games[team] >= this.gamesToWin) {
        this.winner = team;
        return { call: 'Game', game: team, match: team, broke, games: this.games.slice() };
      }
      this.gameIndex++;
      return { call: 'Game', game: team, match: null, broke, games: this.games.slice() };
    }
    return { call: this.call(), game: null, match: null, advantageTeam: this.advantage(), deuce: this.isDeuce() };
  }

  snapshot() {
    return {
      format: this.format, points: this.points.slice(), games: this.games.slice(), labels: [this.pointLabel(0), this.pointLabel(1)],
      server: this.server, side: this.side, winner: this.winner, gameIndex: this.gameIndex,
    };
  }
}
