// Krishiv Sports link for Bowling and Krishiv Kart (served by the games
// server, loaded by a tiny snippet in those pages). It only runs when the page
// was opened from the Krishiv Sports menu: the snippet sets window.__KRISHIV_HUB.
//
// TV page:    a "Krishiv Sports" button (and the Home key) back to the games menu;
//             tells the menu which room the game opened (so phones follow);
//             goes back by itself when a phone presses HOME.
// Phone page: a small HOME button (with a confirm) for everyone; follows the
//             TV back to the menu automatically.
(function () {
  const H = window.__KRISHIV_HUB;
  if (!H || window.__KRISHIV_HUB_LOADED) return;
  window.__KRISHIV_HUB_LOADED = true;
  let hubUrl;
  try { hubUrl = new URL(H.hub); } catch { return; }
  const api = `${hubUrl.origin}/api/hub/room/${H.hubRoom}`;
  // Where each game's own TV page keeps its room (their own sessionStorage keys).
  const STORE = { bowling: 'krishivbowling.display.room', kart: 'krishivkart.host.room' }[H.game];
  const css = (el, s) => { el.setAttribute('style', s); return el; };
  let leaving = false;
  const go = (url) => { if (leaving) return; leaving = true; location.href = url; };

  // ------------------------------------------------------------ TV
  if (H.role === 'tv') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = '<span style="font-size:22px;line-height:1">⌂</span><span>Krishiv Sports</span>';
    css(btn, 'position:fixed;left:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:10px 18px;border:0;border-radius:999px;' +
      'font:800 16px "M PLUS Rounded 1c","Nunito",system-ui,sans-serif;color:#1d2433;background:rgba(255,255,255,.88);box-shadow:0 6px 18px rgba(0,0,0,.25);cursor:pointer;opacity:.55;transition:opacity .2s,transform .2s');
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; btn.style.transform = 'scale(1.05)'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '.55'; btn.style.transform = ''; });
    btn.addEventListener('click', () => go(H.hub));
    const mount = () => document.body ? document.body.appendChild(btn) : setTimeout(mount, 50);
    mount();
    window.addEventListener('keydown', (e) => { if (e.code === 'Home') { e.preventDefault(); go(H.hub); } });
    // Report the room this game's TV opened (phones are sent to it).
    let reported = null;
    const report = () => {
      let room = null;
      try { room = JSON.parse(sessionStorage.getItem(STORE) || 'null')?.room || null; } catch { /* */ }
      if (!room || room === reported) return;
      fetch(`${api}/child`, { method: 'POST', body: JSON.stringify({ room, game: H.game }), mode: 'cors' })
        .then((r) => { if (r.ok) reported = room; })
        .catch(() => {});
    };
    setInterval(report, 700);
    // HOME pressed on a phone → back to the menu. Also keeps the menu's room alive.
    let seq = H.seq || 0;
    const poll = () => {
      fetch(`${api}?tv=1`, { mode: 'cors', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((s) => {
        if (!s) return;
        if (s.homeSeq > seq) go(H.hub);
      }).catch(() => {});
    };
    setInterval(poll, 1500);
    poll();
    return;
  }

  // ------------------------------------------------------------ phone
  const back = () => go(H.hub);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Krishiv Sports menu');
  btn.textContent = '⌂';
  const pos = H.pos || 'top-right';
  const place = {
    'top-right': 'top:calc(env(safe-area-inset-top,0px) + 62px);right:10px;',
    'top-left': 'top:calc(env(safe-area-inset-top,0px) + 62px);left:10px;',
    'top-center': 'top:calc(env(safe-area-inset-top,0px) + 6px);left:50%;margin-left:-21px;',
  }[pos] || '';
  css(btn, `position:fixed;${place}z-index:2147483000;width:42px;height:42px;border-radius:50%;border:2px solid rgba(255,255,255,.9);` +
    'font:800 22px system-ui,sans-serif;line-height:1;color:#1d2433;background:rgba(255,255,255,.82);box-shadow:0 4px 12px rgba(0,0,0,.25);touch-action:manipulation;opacity:.8');
  const sheet = document.createElement('div');
  css(sheet, 'position:fixed;inset:0;z-index:2147483001;display:none;align-items:center;justify-content:center;background:rgba(10,16,28,.55);padding:20px;' +
    'font:700 16px "M PLUS Rounded 1c","Nunito",system-ui,sans-serif');
  sheet.innerHTML = '<div style="background:#fff;color:#1d2433;border-radius:24px;padding:22px;max-width:340px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.35)">' +
    '<div style="font-size:40px">⌂</div><div style="font-size:22px;font-weight:800;margin:6px 0">Back to Krishiv Sports?</div>' +
    '<div style="color:#687386;font-weight:700;margin-bottom:16px">The TV and every phone go back to the games menu.</div>' +
    '<button data-k="yes" style="width:100%;border:0;border-radius:16px;padding:14px;font:800 18px inherit;color:#fff;background:linear-gradient(#5ccbff,#0b8fd8);margin-bottom:8px">Go to the menu</button>' +
    '<button data-k="no" style="width:100%;border:0;border-radius:16px;padding:12px;font:800 17px inherit;color:#1f8fe8;background:transparent">Keep playing</button></div>';
  sheet.addEventListener('click', (e) => {
    const k = e.target?.dataset?.k;
    if (k === 'yes') {
      fetch(`${api}/home`, { method: 'POST', mode: 'cors' }).catch(() => {}).finally(() => setTimeout(back, 250));
    } else if (k === 'no' || e.target === sheet) sheet.style.display = 'none';
  });
  btn.addEventListener('click', (e) => { e.stopPropagation(); sheet.style.display = 'flex'; });
  for (const ev of ['pointerdown', 'touchstart']) btn.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  // Into the game's own top bar when it has one (in its button style).
  const HOUSE = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:56%;height:56%"><path d="M3 11.2 12 3.6l9 7.6V20a1.2 1.2 0 0 1-1.2 1.2H15v-6.4H9v6.4H4.2A1.2 1.2 0 0 1 3 20z" fill="currentColor"/></svg>';
  let tries = 0;
  const mount = () => {
    if (!document.body) { setTimeout(mount, 50); return; }
    const slot = H.slot ? document.querySelector(H.slot) : null;
    if (slot) {
      btn.removeAttribute('style');
      btn.className = H.cls || '';
      btn.innerHTML = HOUSE;
      slot.prepend(btn);
    } else if (H.slot && tries++ < 40) { setTimeout(mount, 100); return; } else document.body.appendChild(btn);
    document.body.appendChild(sheet);
  };
  mount();
  // Follow the TV: when it is back on the menu (or in another sport), come home.
  let misses = 0;
  const poll = () => {
    fetch(api, { mode: 'cors', cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((s) => {
      misses = 0;
      if (s.where && s.where !== H.game) back();
    }).catch(() => { misses++; });
  };
  setInterval(poll, 2000);
  setTimeout(poll, 1500);
})();
