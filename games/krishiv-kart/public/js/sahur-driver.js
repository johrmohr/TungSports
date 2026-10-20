// Hand-built seated adaptation of references/sahur-higgsfield.png.
// No remote assets or services at runtime. All surfaces merge into the existing
// driver geometry, retaining LOD, tinting, disposal and CPU rendering support.
export function buildSahur({ THREE, S, T, H, sphere, cyl, torus }) {
  const wood = 0xb4773e, light = 0xc38a4d, dark = 0x653619;
  const smooth = [0.48, 0, 0];
  const ellipsoid = (P, xyz, size, color = wood, surf = smooth) =>
    P.add(sphere(P, 1, 10, 8), color, surf, xyz, [0,0,0], size);
  function curve(P, points, radius, color = wood, surf = smooth) {
    const path = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    P.add(new THREE.TubeGeometry(path, P.n(12, 6), radius, P.n(6, 4), false), color, surf);
  }
  // A continuous rounded log, with fine wood grain baked into vertex colors.
  // The face/body are one silhouette rather than two stacked cylinders.
  const profile = [];
  const rows = H.n(16, 8);
  for(let i=0;i<=rows;i++) {
    const u=i/rows, y=-.38+u*.99;
    const bevel=Math.min(1, u/.028, (1-u)/.028);
    profile.push(new THREE.Vector2(.223-.014*(1-bevel)+.008*Math.sin(u*Math.PI),y));
  }
  H.add(new THREE.LatheGeometry(profile,H.n(48,24)),wood,smooth);
  const g=H.geos[H.geos.length-1], pos=g.attributes.position, col=g.attributes.color;
  for(let i=0;i<pos.count;i++) {
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i),a=Math.atan2(x,z);
    const bend=a+.013*Math.sin(y*14+a*3)+.006*Math.sin(y*31);
    const fine=Math.pow(Math.max(0,Math.sin(bend*97+y*.8)),16);
    const broad=Math.sin(bend*23+.12*Math.sin(y*8));
    const k=.98+.065*broad-.13*fine;
    col.setXYZ(i,col.getX(i)*k,col.getY(i)*k,col.getZ(i)*k);
  }
  H.add(cyl(H,.209,.209,.012,64),0xd5a166,smooth,[0,.605,0]);
  H.add(cyl(H,.209,.209,.012,48),wood,smooth,[0,-.376,0]);
  for(let i=1;i<7;i++) H.add(torus(H,.012+i*.029,.0014,4,32),i%3?0xb17a43:0x92582c,smooth,[0,.612,0],[Math.PI/2,0,0]);
  // Carved cheekbones and chin flow into the front of the log.
  for(const sign of [-1,1]) {
    ellipsoid(H,[sign*.123,.223,.183],[.104,.07,.064],light);
    ellipsoid(H,[sign*.112,.347,.185],[.111,.126,.055],0xa76936);
    ellipsoid(H,[sign*.112,.351,.221],[.085,.099,.056],0xf3e6d0,S.gloss);
    // Large brown irises and black pupils, looking forward.
    ellipsoid(H,[sign*.112,.348,.269],[.055,.069,.021],0x512b17,S.gloss);
    ellipsoid(H,[sign*.112,.349,.287],[.035,.046,.012],0x100c09,S.gloss);
    ellipsoid(H,[sign*.112-.016,.373,.297],[.016,.018,.006],0xffffff,S.gloss);
    ellipsoid(H,[sign*.112+.013,.332,.298],[.006,.007,.004],0xfaf3df,S.gloss);
    const cx=sign*.112;
    curve(H,[[cx-.085,.354,.236],[cx-.064,.421,.245],[cx,.452,.247],[cx+.064,.421,.245],[cx+.085,.354,.236]],.011,0x8b4a24);
    curve(H,[[cx-.084,.348,.239],[cx-.055,.274,.248],[cx,.253,.249],[cx+.055,.274,.248],[cx+.084,.348,.239]],.009,0xa16635);
    // Arched brows, not straight painted bars.
    curve(H,[[cx-.085,.459,.218],[cx-.045,.492,.234],[cx+.015,.494,.237],[cx+.076,.472,.22]],.019,0x593018);
    curve(H,[[cx-.073,.469,.231],[cx-.025,.492,.251],[cx+.047,.484,.245]],.004,0x915c32);
  }
  ellipsoid(H,[0,.303,.231],[.034,.102,.046],light);
  ellipsoid(H,[0,.238,.28],[.047,.032,.045],0xc78d50);
  for(const sign of [-1,1]) {
    ellipsoid(H,[sign*.032,.226,.286],[.025,.019,.022],light);
    ellipsoid(H,[sign*.029,.217,.3],[.012,.006,.008],dark);
  }
  ellipsoid(H,[0,.086,.204],[.103,.06,.045],light);
  // Curved smiling mouth with a shallow dark cavity and inset teeth.
  const mouth=new THREE.Shape();
  mouth.moveTo(-.122,.172);
  mouth.bezierCurveTo(-.06,.137,.055,.137,.123,.183);
  mouth.bezierCurveTo(.07,.074,-.058,.069,-.122,.172);
  H.add(new THREE.ShapeGeometry(mouth,24),0x32180e,S.skin,[0,0,.257]);
  curve(H,[[-.124,.174,.247],[-.07,.143,.267],[0,.132,.273],[.075,.15,.265],[.125,.184,.24]],.009,0x8e4b23);
  curve(H,[[-.106,.139,.25],[-.055,.099,.266],[.01,.092,.269],[.073,.119,.258],[.113,.165,.24]],.012,0xc18a50);
  curve(H,[[-.079,.137,.261],[-.025,.124,.267],[.028,.126,.267],[.078,.145,.259]],.008,0xe3c394,S.skin);
  // Slim wooden arms, relaxed bent elbows, and individual fingers on the wheel.
  for(const sign of [-1,1]) {
    const shoulder=[sign*.23,.91,-.28],elbow=[sign*.31,.70,-.08],hand=[sign*.15,.76,.15];
    ellipsoid(T,shoulder,[.048,.09,.05]);
    curve(T,[shoulder,[sign*.29,.8,-.2],elbow],.032);
    curve(T,[elbow,[sign*.26,.7,.035],hand],.029,light);
    ellipsoid(T,hand,[.043,.035,.045],light);
    for(let f=0;f<4;f++) {
      const x=sign*.15+(f-1.5)*.017;
      curve(T,[[x,.772,.17],[x,.755,.195],[x,.733,.184]],.008,light);
    }
    curve(T,[[sign*.12,.77,.14],[sign*.103,.746,.155],[sign*.115,.73,.172]],.011,wood);
    // Bare feet with distinct toes, seated naturally at the pedals.
    curve(T,[[sign*.105,.5,-.26],[sign*.145,.59,.04],[sign*.145,.46,.31]],.037,wood);
    ellipsoid(T,[sign*.145,.443,.37],[.065,.036,.115],light);
    for(let toe=0;toe<5;toe++) ellipsoid(T,[sign*.145+(toe-2)*.024,.44,.46-Math.abs(toe-1)*.009],[.014,.018,.027],light);
  }
  // Bat carried beside the cockpit, clear of the face and steering wheel.
  const points=[[.026,0],[.026,.05],[.019,.08],[.02,.2],[.032,.35],[.052,.5],[.057,.65],[.049,.72],[0,.735]];
  const shape=new THREE.LatheGeometry(points.map(([r,y])=>new THREE.Vector2(r,y)),T.n(32,16));
  T.add(shape,0xc28a4b,smooth,[.37,.55,-.34],[0,0,-.22]);
  // Narrow retaining strap makes the mounted prop read as carried equipment.
  T.add(torus(T,.03,.009,6,16),0x694222,S.cloth,[.392,.65,-.34],[Math.PI/2,0,-.22]);
}
