import { buildSahur } from './sahur-driver.js';
// Procedural racing adaptations of the reference designs in docs/brainrot-roster.md.
// Geometry uses the shared Parts collector, so each driver remains two draw calls.
export function createBrainrotDrivers({ THREE, S, sphere, cyl, cone, torus, box, rbox, eyes, arms, legs }) {
  const O = [0, 0, 0], HALF = Math.PI / 2;
  const ball = (P, p, scale, color) => P.add(sphere(P, 1, 16, 12), color, S.skin, p, O, scale);
  const face = (H, y = .25, z = .23, width = .1) => {
    eyes(H, width, y, z, .072, { iris: 0x38251b });
    H.path([[-.075, y-.12, z], [0, y-.145, z+.02], [.075, y-.12, z]], .012, 0x38251b, S.skin);
  };
  const body = (T, color) => ball(T, [0,.67,-.3], [.23,.27,.2], color);
  function cup(H, ninja = false) {
    H.add(cyl(H,.27,.21,.4,24),0xfff5e4,S.gloss,[0,.23,0]);
    H.add(torus(H,.255,.022,6,24),0xffffff,S.gloss,[0,.44,0],[HALF,0,0]);
    H.add(cyl(H,.235,.235,.012,24),0x89522e,S.skin,[0,.435,0]);
    if (!ninja) H.add(torus(H,.105,.032,8,20),0xfff5e4,S.gloss,[.29,.24,0]);
    // Visible cream heart, inset on the coffee surface.
    ball(H,[-.04,.448,.015],[.055,.008,.055],0xffe1b4);
    ball(H,[.04,.448,.015],[.055,.008,.055],0xffe1b4);
    ball(H,[0,.448,.055],[.045,.008,.06],0xffe1b4);
    if(ninja) {
      H.add(cyl(H,.277,.266,.08,24),0x23232b,S.cloth,[0,.37,0]);
      H.add(cyl(H,.25,.23,.1,24),0x23232b,S.cloth,[0,.12,0]);
      H.add(box(.12,.055,.018),0xa7b0b1,S.metal,[0,.37,.272]);
      H.add(torus(H,.265,.025,6,24),0xc68d51,S.skin,[0,.44,0],[HALF,0,0]);
      eyes(H,.1,.26,.255,.06,{iris:0x17171c});
      H.path([[.22,.29,-.1],[.38,.33,-.22],[.43,.24,-.3]],.033,0x23232b,S.cloth);
    } else { face(H,.25,.235); }
  }
  function banana(T) {
    T.path([[0,.45,-.3],[-.08,.64,-.34],[0,.86,-.3],[.08,.98,-.28]],.15,0xf6ce32,S.skin);
    for(const sx of [-1,1]) T.path([[0,.91,-.29],[sx*.23,.87,-.32],[sx*.32,.63,-.39]],.075,0xffdf42,S.skin);
    T.path([[0,.9,-.36],[0,.8,-.58],[0,.54,-.64]],.08,0xe1b72a,S.skin);
  }
  function plane(T, goose) {
    ball(T,[0,.69,-.35],[.24,.2,.49],goose?0xd5dedc:0x707e4a);
    T.add(rbox(T,1.18,.065,.28,.025),0x748267,S.metal,[0,.7,-.32]);
    T.add(rbox(T,.57,.045,.18,.015),0x748267,S.metal,[0,.79,-.74]);
    T.add(cone(T,.16,.28,3),0x748267,S.metal,[0,.88,-.7]);
    for(const sx of [-1,1]) {
      ball(T,[sx*.42,.69,-.19],[.09,.09,.22],0x505f48);
      T.add(box(.035,.3,.025),0x242a29,S.metal,[sx*.42,.69,.04]);
      T.add(box(.29,.03,.025),0x242a29,S.metal,[sx*.42,.69,.04]);
      ball(T,[sx*.42,.69,.06],[.05,.05,.04],0xccc3a0);
    }
  }
  function elephant(H, color) {
    ball(H,[0,.24,0],[.24,.25,.22],color);
    for(const sx of [-1,1]) ball(H,[sx*.26,.23,-.015],[.18,.23,.06],color);
    eyes(H,.11,.3,.19,.065);
    H.path([[0,.23,.2],[0,.04,.32],[0,-.16,.35],[.08,-.2,.38]],.066,color,S.skin);
  }
  return {
    sahur(T,H) {
      buildSahur({ THREE, S, T, H, sphere, cyl, torus });
    },
    ballerina(T,H) {
      body(T,0xf3a9c5); arms(T,0xf3d3be,0xf3d3be,.036,.047); legs(T,0xf3d3be,0xe99ebc,{r:.035});
      T.add(cyl(T,.17,.39,.14,24),0xf6b4d0,S.cloth,[0,.53,-.3]);
      for(let i=0;i<16;i++) {const a=i*Math.PI/8; ball(T,[Math.sin(a)*.29,.49,-.3+Math.cos(a)*.29],[.09,.025,.09],0xffc9df);}
      cup(H);
    },
    cappuccino(T,H) {
      body(T,0x24242b); arms(T,0x24242b,0xddd0ba,.045,.055); legs(T,0x24242b,0x24242b,{r:.05}); cup(H,true);
      T.add(box(.4,.06,.32),0xb62e35,S.cloth,[0,.56,-.29]);
      for(const sx of [-1,1]) {
        T.tube([sx*.22,.55,-.53],[-sx*.29,1.13,-.53],.025,0xb9c8cf,S.metal);
        T.tube([-sx*.29,1.13,-.53],[-sx*.38,1.24,-.53],.035,0x24242b,S.cloth);
        T.add(box(.15,.025,.06),0xbba35d,S.metal,[-sx*.29,1.13,-.53],[0,0,sx*.7]);
      }
    },
    trippi(T,H) {
      // Orange segmented shrimp tail and legs; tabby cat head variant.
      for(let i=0;i<6;i++) ball(T,[0,.63-i*.015,-.24-i*.09],[.23-i*.022,.2-i*.015,.09],i%2?0xec8551:0xffae76);
      for(const sx of [-1,1]) for(let i=0;i<3;i++) T.path([[sx*.17,.65,-.25-i*.12],[sx*.29,.5,-.18-i*.12],[sx*.34,.48,-.09-i*.12]],.018,0xe66c40,S.skin);
      ball(H,[0,.22,0],[.24,.21,.19],0xc48e59);
      for(const sx of [-1,1]) {H.add(cone(H,.105,.2,3),0xc48e59,S.fur,[sx*.16,.43,0]); ball(H,[sx*.08,.12,.17],[.09,.065,.06],0xffe8cb);}
      face(H,.24,.17); ball(H,[0,.16,.23],[.035,.025,.025],0xc17e7b);
      for(const sx of [-1,1]) for(let i=0;i<3;i++) H.tube([sx*.11,.13,.21],[sx*.32,.1+i*.04,.2],.004,0xffeddb,S.fur);
    },
    chimpanzini(T,H) {
      banana(T); arms(T,0x719e37,0x739d3d,.055,.065); legs(T,0x719e37,0x719e37,{r:.055});
      ball(H,[0,.24,0],[.245,.25,.2],0x6c9c36);
      for(const sx of [-1,1]) {ball(H,[sx*.24,.23,0],[.09,.11,.055],0x769e3b); ball(H,[sx*.09,.25,.15],[.11,.13,.065],0xcd9981);}
      ball(H,[0,.12,.18],[.14,.09,.065],0xcd9981); face(H,.27,.21);
    },
    tralalero(T,H) {
      ball(T,[0,.71,-.31],[.26,.25,.42],0x7796a6); arms(T,0x7796a6,0x7796a6,.045,.05);
      H.add(sphere(H,.28,20,14),0x7796a6,S.skin,[0,.18,.04],O,[1,.78,1.45]);
      ball(H,[0,.09,.12],[.235,.09,.32],0xdce5df);
      eyes(H,.16,.25,.34,.055);
      H.path([[-.18,.09,.3],[0,.065,.4],[.18,.09,.3]],.018,0x293944,S.skin);
      for(let i=-2;i<=2;i++) H.add(cone(H,.023,.045,3),0xffffff,S.gloss,[i*.055,.075,.38-Math.abs(i)*.025],[Math.PI,0,0]);
      T.add(cone(T,.18,.37,3),0x607f91,S.skin,[0,1.16,-.54]);
      T.path([[0,.72,-.55],[0,.78,-.83],[0,.94,-.95]],.075,0x7796a6,S.skin);
      T.add(cone(T,.17,.31,3),0x607f91,S.skin,[0,1.05,-.93],[0,0,-.3]);
      for(const sx of [-1,1]) for(let i=0;i<3;i++) H.path([[sx*(.23-i*.012),.2,.15-i*.055],[sx*(.25-i*.012),.1,.15-i*.055]],.006,0x476271,S.skin);
      for(const [x,z] of [[-.24,.12],[.24,.12],[0,-.65]]) {
        T.limb([x*.6,.66,z-.03],[x,.48,z],.055,0x7796a6,S.skin);
        T.add(rbox(T,.17,.12,.3,.045),0x1679e5,S.cloth,[x,.46,z+.09]);
        T.add(rbox(T,.18,.035,.31,.01),0xf3f7f5,S.rubber,[x,.405,z+.09]);
        for(let i=0;i<3;i++) T.tube([x-.05,.523,z+.05+i*.035],[x+.05,.523,z+.05+i*.035],.006,0xffffff,S.cloth);
      }
    },
    bananita(T,H) {
      banana(T); ball(H,[0,.22,0],[.21,.23,.3],0x8aa8b0); ball(H,[0,.17,.3],[.1,.07,.21],0xa2bac0);
      eyes(H,.15,.28,.16,.055); H.path([[-.07,.13,.39],[0,.12,.48],[.07,.13,.39]],.008,0x425b67,S.skin);
      for(const sx of [-1,1]) ball(T,[sx*.25,.8,-.26],[.18,.045,.1],0x8aa8b0);
      T.add(cone(T,.15,.25,3),0x7a99a2,S.skin,[0,.97,-.48]);
    },
    lirili(T,H) {
      T.add(cyl(T,.23,.25,.5,20),0x729b58,S.skin,[0,.7,-.29]); arms(T,0x729b58,0x729b58,.07,.07);
      elephant(H,0x9d9279);
      for(let i=0;i<10;i++) {const a=i*Math.PI/5; T.tube([Math.sin(a)*.24,.48,-.29+Math.cos(a)*.24],[Math.sin(a)*.23,.93,-.29+Math.cos(a)*.23],.009,0x426e3d,S.skin);}
      legs(T,0x729b58,0x8f653b,{r:.07});
      for(const sx of [-1,1]) {T.add(box(.13,.03,.24),0x684b2d,S.cloth,[sx*.13,.405,.4]); T.add(box(.13,.04,.055),0xc09a66,S.cloth,[sx*.13,.48,.43]);}
    },
    patapim(T,H) {
      T.add(cyl(T,.24,.32,.48,14),0x6d4e30,S.fur,[0,.67,-.3]); arms(T,0x6d4e30,0x9d7a52,.07,.09); legs(T,0x6d4e30,0xa68a64,{r:.09});
      ball(H,[0,.23,0],[.26,.26,.22],0x715239); ball(H,[0,.18,.15],[.19,.19,.11],0xb19973);
      face(H,.28,.24); ball(H,[0,.13,.33],[.08,.18,.12],0xbda583);
      for(let i=0;i<11;i++) {const a=i*2.4; ball(H,[Math.sin(a)*.22,.43+(i%3)*.035,Math.cos(a)*.18-.04],[.12,.1,.12],i%2?0x477139:0x648644);}
      for(let i=0;i<9;i++) {const a=i*.7; T.tube([Math.sin(a)*.27,.45,-.3+Math.cos(a)*.27],[Math.sin(a)*.24,.85,-.3+Math.cos(a)*.24],.012,0x46361e,S.fur);}
    },
    bombardiro(T,H) {
      plane(T,false); ball(H,[0,.16,.05],[.25,.17,.25],0x6e854d);
      H.add(rbox(H,.36,.16,.48,.055),0x789455,S.skin,[0,.1,.28]);
      H.add(rbox(H,.34,.055,.45,.02),0xb9bd86,S.skin,[0,.005,.28]);
      eyes(H,.16,.27,.13,.065);
      for(const sx of [-1,1]) for(let i=0;i<5;i++) H.add(cone(H,.022,.045,3),0xfff4da,S.gloss,[sx*.17,.025,.12+i*.075],[Math.PI,0,0]);
      for(let i=0;i<4;i++) H.add(cone(H,.045,.07,4),0x425e33,S.skin,[0,.3,.12-i*.095]);
    },
    gusini(T,H) {
      plane(T,true); H.path([[0,-.02,0],[0,.18,-.05],[0,.36,0]],.1,0xf1eee4,S.fur);
      ball(H,[0,.36,.06],[.15,.15,.18],0xf6f2e7); ball(H,[0,.32,.24],[.09,.05,.15],0xea9a31);
      eyes(H,.105,.39,.16,.043);
    },
    saturnita(T,H) {
      ball(T,[0,.7,-.3],[.33,.3,.32],0xcc9b64);
      for(let i=0;i<5;i++) T.add(torus(T,.42+i*.018,.012,4,32),i%2?0xd9bd8d:0xa47b4d,S.skin,[0,.69,-.3],[HALF,.15,.18]);
      legs(T,0xe8e5dc,0x343433,{r:.075});
      ball(H,[0,.24,0],[.24,.23,.21],0xf3eee2);
      ball(H,[-.11,.32,.14],[.095,.1,.07],0x3e3935); ball(H,[0,.1,.19],[.18,.1,.09],0xe8aaa0);
      eyes(H,.1,.27,.185,.055);
      for(const sx of [-1,1]) {ball(H,[sx*.26,.3,0],[.13,.065,.07],0xf3eee2); H.add(cone(H,.045,.17,8),0xc9b68c,S.skin,[sx*.17,.47,-.02],[0,0,-sx*.25]); ball(H,[sx*.07,.11,.27],[.025,.02,.012],0x865a54);}
    },
  };
}
