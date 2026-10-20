// Vector art for the sport cards (drawn in code, no image files).

export const SPORT_STYLE = {
  tennis: { g: 'linear-gradient(160deg, #8fe07a 0%, #36a852 55%, #1f7a3b 100%)' },
  golf: { g: 'linear-gradient(170deg, #9ad8ff 0%, #5ab8f0 45%, #2f9e44 46%, #23803a 100%)' },
  bowling: { g: 'linear-gradient(165deg, #ffcf7a 0%, #e89a3c 55%, #b5651d 100%)' },
  kart: { g: 'linear-gradient(160deg, #ff8fb3 0%, #e8384f 50%, #9b1d3a 100%)' },
};

export const SPORT_ART = {
  tennis: `<svg class="art" viewBox="0 0 400 260" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="tcourt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6cc35a"/><stop offset="1" stop-color="#3d9a3f"/></linearGradient>
      <radialGradient id="tball" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#f4ff9a"/><stop offset=".6" stop-color="#d7f25c"/><stop offset="1" stop-color="#9fbf1f"/></radialGradient>
    </defs>
    <path d="M70 260 L150 110 L250 110 L330 260 Z" fill="url(#tcourt)" stroke="#fff" stroke-width="4"/>
    <path d="M110 260 L170 110 M290 260 L230 110 M200 110 L200 175 M120 175 L280 175" stroke="#fff" stroke-width="3" fill="none" opacity=".9"/>
    <rect x="128" y="132" width="144" height="16" fill="rgba(30,40,40,.55)"/>
    <path d="M128 132 H272" stroke="#fff" stroke-width="4"/>
    <g transform="translate(300 70) rotate(35)">
      <ellipse cx="0" cy="0" rx="34" ry="44" fill="none" stroke="#fff" stroke-width="7"/>
      <path d="M-30 -10 H30 M-32 4 H32 M-28 18 H28 M-20 -26 H20 M-10 -38 V38 M6 -40 V40 M-24 -30 V30 M22 -32 V32" stroke="#fff" stroke-width="1.5" opacity=".7"/>
      <rect x="-6" y="44" width="12" height="54" rx="5" fill="#1d2433"/>
    </g>
    <g>
      <path d="M58 92 Q100 66 150 80" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" opacity=".55"/>
      <path d="M48 108 Q96 88 140 96" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" opacity=".35"/>
      <circle cx="168" cy="82" r="24" fill="url(#tball)"/>
      <path d="M150 66 Q166 82 152 100 M186 66 Q170 82 184 100" stroke="#fff" stroke-width="3.5" fill="none"/>
    </g>
  </svg>`,
  golf: `<svg class="art" viewBox="0 0 400 260" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <radialGradient id="gball" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cfd8e3"/></radialGradient>
    </defs>
    <circle cx="330" cy="52" r="26" fill="#fff6b8" opacity=".9"/>
    <path d="M0 150 Q90 112 200 132 T400 118 V260 H0 Z" fill="#3fae4f"/>
    <path d="M0 176 Q120 140 230 168 T400 160 V260 H0 Z" fill="#2f9443"/>
    <ellipse cx="270" cy="150" rx="70" ry="16" fill="#7fd36e"/>
    <ellipse cx="290" cy="150" rx="7" ry="3" fill="#1d2433"/>
    <path d="M290 150 V58" stroke="#f4f6f9" stroke-width="5" stroke-linecap="round"/>
    <path d="M292 60 L336 74 L292 88 Z" fill="#e8384f"/>
    <path d="M60 230 L66 206 L72 230 Z" fill="#f4f6f9"/>
    <circle cx="66" cy="196" r="15" fill="url(#gball)"/>
    <g fill="#9aa5b1" opacity=".6"><circle cx="61" cy="191" r="2"/><circle cx="68" cy="189" r="2"/><circle cx="72" cy="196" r="2"/><circle cx="62" cy="199" r="2"/><circle cx="68" cy="202" r="2"/></g>
    <path d="M90 200 Q170 60 266 146" stroke="#fff" stroke-width="3" fill="none" stroke-dasharray="2 10" stroke-linecap="round" opacity=".9"/>
    <g fill="#236b33"><circle cx="40" cy="128" r="22"/><circle cx="64" cy="120" r="18"/><rect x="48" y="138" width="6" height="16" fill="#6b4a2b"/></g>
  </svg>`,
  bowling: `<svg class="art" viewBox="0 0 400 260" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient id="lane" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7d9a3"/><stop offset="1" stop-color="#d9a35c"/></linearGradient>
      <radialGradient id="bball" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#7fb6ff"/><stop offset=".55" stop-color="#2f7bf5"/><stop offset="1" stop-color="#123a8a"/></radialGradient>
      <linearGradient id="pin" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e9edf2"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#cfd6de"/></linearGradient>
    </defs>
    <path d="M110 260 L176 90 L224 90 L290 260 Z" fill="url(#lane)"/>
    <path d="M150 260 L188 90 M250 260 L212 90 M200 260 V90" stroke="#c48a45" stroke-width="2" opacity=".5"/>
    <g id="p">
      <path d="M0 0 C-7 0 -8 10 -5 16 C-10 26 -11 40 -6 52 L6 52 C11 40 10 26 5 16 C8 10 7 0 0 0 Z" fill="url(#pin)" stroke="#9aa5b1" stroke-width="1"/>
      <path d="M-5 14 H5 M-6 19 H6" stroke="#e8384f" stroke-width="2.5"/>
    </g>
    <use href="#p" x="200" y="40"/><use href="#p" x="184" y="34"/><use href="#p" x="216" y="34"/>
    <use href="#p" x="170" y="28"/><use href="#p" x="200" y="28"/><use href="#p" x="230" y="28"/>
    <circle cx="214" cy="198" r="40" fill="url(#bball)"/>
    <g fill="#0c2b66"><circle cx="202" cy="184" r="5"/><circle cx="218" cy="180" r="5"/><circle cx="212" cy="196" r="6"/></g>
    <path d="M96 218 Q140 206 170 210" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" opacity=".55"/>
  </svg>`,
  kart: `<svg class="art" viewBox="0 0 400 260" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <pattern id="chk" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="#fff"/><rect x="10" y="10" width="10" height="10" fill="#fff"/></pattern>
    </defs>
    <path d="M0 196 H400 V260 H0 Z" fill="#3b3f4a"/>
    <path d="M0 214 H400" stroke="#fff" stroke-width="5" stroke-dasharray="34 26"/>
    <g opacity=".55" stroke="#fff" stroke-width="5" stroke-linecap="round"><path d="M24 132 H96"/><path d="M10 152 H80"/><path d="M36 172 H110"/></g>
    <g transform="translate(250 30) rotate(12)"><rect x="0" y="0" width="80" height="54" fill="#1d2433"/><rect x="0" y="0" width="80" height="54" fill="url(#chk)"/><rect x="-6" y="0" width="6" height="120" fill="#c9ced6"/></g>
    <g transform="translate(118 112)">
      <path d="M10 70 L30 30 H120 L150 52 L172 56 L176 78 H6 Z" fill="#ffcf3f" stroke="#1d2433" stroke-width="4" stroke-linejoin="round"/>
      <path d="M44 30 L60 6 H96 L106 30" fill="#2f7bf5" stroke="#1d2433" stroke-width="4" stroke-linejoin="round"/>
      <circle cx="78" cy="2" r="16" fill="#d99b38" stroke="#1d2433" stroke-width="4"/>
      <circle cx="73" cy="0" r="3" fill="#1d2433"/><circle cx="84" cy="0" r="3" fill="#1d2433"/>
      <circle cx="38" cy="80" r="20" fill="#1d2433"/><circle cx="38" cy="80" r="8" fill="#c9ced6"/>
      <circle cx="146" cy="80" r="20" fill="#1d2433"/><circle cx="146" cy="80" r="8" fill="#c9ced6"/>
      <path d="M150 46 L176 40" stroke="#1d2433" stroke-width="5" stroke-linecap="round"/>
    </g>
  </svg>`,
};
