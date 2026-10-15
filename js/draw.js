// Drawing: greyscale arrays to canvas pixels, and the profiles-on-gel overlay
// (port of plot_profiles_on_gel in scoping/band_peaks.py: lines and markers only).

export const COLOURS = { profile: "#2a78d6", peak: "#d62a2a", saturated: "#000000", shoulder: "#e8730c",
                         lane: "#1f4e8c" };

// Letters for bands within a lane, counted from the top: A, B, ... Z, AA, AB, ...
// A band's name is its lane number and letter: 1.A, 1.B, ... 2.A, ...
export function bandLetter(i) {
  let name = "";
  for (let k = i + 1; k > 0; k = Math.floor((k - 1) / 26)) name = String.fromCharCode(65 + ((k - 1) % 26)) + name;
  return name;
}

export function greyToImageData(ctx, grey, w, h) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const v = grey[i];
    if (Number.isNaN(v)) { d[i * 4 + 3] = 0; continue; } // outside the original image: transparent
    const b = Math.round(Math.min(Math.max(v, 0), 1) * 255);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = b;
    d[i * 4 + 3] = 255;
  }
  return img;
}

// Overlay on a canvas already holding the gel, drawn `top` pixels below the canvas top.
// px = size of one screen pixel in canvas pixels, so lines stay visible when scaled down.
// showProfiles: draw each lane's profile with peaks, saturated peaks and shoulders marked.
// Otherwise only marked bands: ladder bands filled and labelled with their size (marks:
// per lane [{x, y, kda, ladder, i}]) and the bands the user clicked (picks: per lane
// [{x, y, name}]) hollow and labelled with their name. drag: a ladder marker being moved.
// strips: per lane [c0, c1), the columns its profile is read from (shaded with profiles).
export function drawOverlay(ctx, lanes, results, top, px, showProfiles = false, marks = null, drag = null, picks = null,
                            strips = null) {
  ctx.save();
  ctx.lineJoin = "round";
  lanes.forEach(([start, end], li) => {
    drawLaneNumber(ctx, li, start, end, top, px);
    if (!showProfiles) {
      ctx.strokeStyle = COLOURS.peak;
      ctx.lineWidth = 1.8 * px;
      for (const q of (picks && picks[li]) || []) {
        const moving = drag && drag.mark === q;
        const x = moving ? drag.x : q.x, y = top + (moving ? drag.y : q.y);
        ctx.globalAlpha = moving ? 0.6 : 1;
        ctx.beginPath();
        ctx.arc(x, y, 6 * px, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.globalAlpha = 1;
        label(ctx, q.name, x + 9 * px, y, px, "#222222");
      }
      for (const q of (marks && marks[li]) || []) {
        const moving = drag && drag.mark === q;
        const x = moving ? drag.x : q.x, y = top + (moving ? drag.y : q.y);
        ctx.fillStyle = COLOURS.peak;
        ctx.globalAlpha = moving ? 0.6 : q.estimated ? 0.4 : 1; // pale: placed by estimate, not on a band
        ctx.beginPath();
        ctx.arc(x, y, 4 * px, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
        label(ctx, String(q.kda), x + 7 * px, y, px, COLOURS.peak);
      }
      return;
    }
    if (strips && strips[li]) { // the columns this profile is read from
      const [c0, c1] = strips[li], height = ctx.canvas.height - top;
      ctx.fillStyle = "rgba(42, 120, 214, 0.13)";
      ctx.fillRect(c0, top, c1 - c0, height);
      ctx.strokeStyle = "rgba(42, 120, 214, 0.5)";
      ctx.lineWidth = 1 * px;
      ctx.beginPath();
      for (const c of [c0, c1]) { ctx.moveTo(c, top); ctx.lineTo(c, top + height); }
      ctx.stroke();
    }
    const { bands, profile, noise } = results[li];
    let min = Infinity, max = -Infinity;
    for (const v of profile) if (!Number.isNaN(v)) { min = Math.min(min, v); max = Math.max(max, v); }
    if (min === Infinity) return; // lane has no pixels
    const lw = 10 * noise || 1e-6;
    const scale = (v) => Math.asinh(Math.max(v - min, 0) / lw);
    const topScale = scale(max) || 1;
    const x = (v) => start + (0.9 * (end - start) * scale(v)) / topScale;

    ctx.strokeStyle = COLOURS.profile;
    ctx.lineWidth = 1.3 * px;
    ctx.beginPath();
    let pen = false; // rows without pixels (NaN) break the line
    profile.forEach((v, y) => {
      if (Number.isNaN(v)) { pen = false; return; }
      if (pen) ctx.lineTo(x(v), top + y); else ctx.moveTo(x(v), top + y);
      pen = true;
    });
    ctx.stroke();

    for (const b of bands) {
      const bx = x(profile[b.y]), by = top + b.y;
      if (b.kind === "peak") {
        ctx.strokeStyle = b.saturated ? COLOURS.saturated : COLOURS.peak;
        ctx.lineWidth = 1.6 * px;
        ctx.beginPath();
        ctx.arc(bx, by, 4.5 * px, 0, 2 * Math.PI);
        ctx.stroke();
      } else {
        ctx.fillStyle = COLOURS.shoulder;
        ctx.beginPath();
        ctx.moveTo(bx - 4 * px, by - 4.5 * px);
        ctx.lineTo(bx + 5 * px, by);
        ctx.lineTo(bx - 4 * px, by + 4.5 * px);
        ctx.closePath();
        ctx.fill();
      }
    }
  });
  ctx.restore();
}

// Small bold label with a white halo, readable on light and dark parts of the gel.
function label(ctx, text, x, y, px, colour) {
  ctx.save();
  ctx.font = `bold ${Math.round(11 * px)}px system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3 * px;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Dead space (spaces between dividers that aren't lanes): washed out, with a "+" above to
// make it a lane again. hover: {start, end, dead} under the pointer in the strip above the
// gel: a lane's number turns into a red "x" (click: make it dead space), a dead space's
// "+" darkens.
export function drawDeadSpace(ctx, dead, top, height, px, hover = null, surface = "#fff") {
  ctx.save();
  ctx.font = `bold ${Math.round(16 * px)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const [start, end] of dead) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.fillRect(start, top, end - start, height);
    const on = hover && hover.dead && hover.start === start;
    ctx.fillStyle = on ? COLOURS.lane : "rgba(31, 78, 140, 0.45)";
    ctx.fillText("+", (start + end) / 2, top - 3 * px);
  }
  if (hover && !hover.dead) {
    ctx.fillStyle = surface;
    ctx.fillRect(hover.start + 1, 0, hover.end - hover.start - 2, top);
    ctx.fillStyle = COLOURS.peak;
    ctx.fillText("×", (hover.start + hover.end) / 2, top - 3 * px);
  }
  ctx.restore();
}

function drawLaneNumber(ctx, li, start, end, top, px) {
  ctx.fillStyle = COLOURS.lane;
  ctx.font = `bold ${Math.round(14 * px)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(String(li + 1), (start + end) / 2, top - 4 * px);
}

export function drawDividers(ctx, bounds, top, height, px, active = -1) {
  ctx.save();
  bounds.forEach((b, i) => {
    ctx.strokeStyle = i === active ? COLOURS.peak : "rgba(31, 78, 140, 0.55)";
    ctx.lineWidth = (i === active ? 2 : 1) * px;
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.beginPath();
    ctx.moveTo(b, top);
    ctx.lineTo(b, top + height);
    ctx.stroke();
  });
  ctx.restore();
}

// A figure: the gel (analysed area) on white, outlined, with ladder sizes marked down the
// side: left = [{y, kda}] for the left side, right = the same for the right side (or
// null). Labels that would overlap the one above get a longer line and sit further out.
// Above the gel (top, optional): per lane {x0, x1, id, text} (columns of the gel) drawn
// as lane labels, then annotations (tilted 45° if any is wider than its lane), then
// groups {x0, x1, name, level}: a bar over their lanes with the name above, one row per
// level. top.show = {ids, notes, groups} switches rows on and off.
// Drawn at the gel's own resolution; text and lines scale with its height.
export function renderFigure(canvas, grey, w, h, left, right, top = null) {
  const base = Math.max(14, Math.round(h / 30));
  const fs0 = Math.round(1.3 * base);                    // full size for size labels and "MW (kDa)"
  // size labels shrink (to 65% at most) so the closest two ladder bands' labels fit side
  // by side; only if that isn't enough does a label move out onto a longer line
  const gaps = [left, right].filter(Boolean).flatMap((m) => {
    const ys = m.map((q) => q.y).sort((a, b) => a - b);
    return ys.slice(1).map((y, i) => y - ys[i]);
  });
  const fs = gaps.length ? Math.max(Math.round(0.65 * fs0), Math.min(fs0, Math.floor(Math.min(...gaps) / 1.15))) : fs0;
  const lw = 2 * Math.max(1, base / 10);                 // lines and outline
  const tick = Math.round(base * 1.2), gap = Math.round(fs * 0.25), sep = fs * 1.15; // sep: closest labels on one level
  const ctx = canvas.getContext("2d");
  const font = `${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;

  // place each side's labels: level 0 next to the gel; a label too close to the one
  // above on its level goes to the next level out (a longer line)
  const layout = (marks) => {
    if (!marks) return null;
    ctx.font = font;
    const textW = Math.max(...marks.map((q) => ctx.measureText(String(q.kda)).width));
    const lastY = [];
    const placed = [...marks].sort((a, b) => a.y - b.y).map((q) => {
      let level = 0;
      while (lastY[level] !== undefined && q.y - lastY[level] < sep) level++;
      lastY[level] = q.y;
      return { ...q, level };
    });
    const levels = Math.max(...placed.map((q) => q.level)) + 1;
    const reach = (level) => tick + level * (textW + 2 * gap + tick);
    const kw = ctx.measureText("MW (kDa)").width; // sits after a tick's length and a gap, like the sizes
    return { placed, reach, width: Math.ceil(Math.max(reach(levels - 1) + gap + textW, tick + gap + kw) + fs * 0.6) };
  };
  const L = layout(left), R = layout(right);
  const ml = L ? L.width : Math.round(fs * 0.6);
  let mr = R ? R.width : Math.round(fs * 0.6);
  // rows above the gel, bottom (next to the gel) to top
  const afs = Math.round(fs0 * 0.8), afont = `${afs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const show = (top && top.show) || {};
  const lanes = (top && top.lanes) || [], groups = (top && top.groups) || [];
  // lane labels: one or more lines (typed with Enter), shrunk (to 60% at most) so the
  // widest line fits over its lane
  const idLines = lanes.map((l) => (l.id ? String(l.id).split("\n").map((t) => t.trim()) : []));
  ctx.font = afont;
  const tooWide = Math.max(1, ...lanes.map((l, i) =>
    Math.max(0, ...idLines[i].map((t) => ctx.measureText(t).width)) / Math.max(1, (l.x1 - l.x0) * 0.92)));
  const ifs = Math.max(Math.round(0.6 * afs), Math.floor(afs / tooWide));
  const idFont = `${ifs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const nLines = Math.max(0, ...idLines.map((ls) => ls.length));
  const ids = show.ids && nLines ? Math.round(ifs * (1.15 * nLines + 0.25)) : 0;
  const notes = show.notes ? lanes.filter((l) => l.text) : [];
  const tilt = notes.some((l) => ctx.measureText(l.text).width > (l.x1 - l.x0) * 0.92);
  const notesH = !notes.length ? 0
    : tilt ? Math.ceil(Math.max(...notes.map((l) => ctx.measureText(l.text).width)) * Math.SQRT1_2 + afs * 1.2)
    : Math.round(afs * 1.4);
  const levels = show.groups && groups.length ? Math.max(...groups.map((g) => g.level)) + 1 : 0;
  const groupH = Math.round(afs * 2.0);
  const above = ids + notesH + levels * groupH;
  // tilted annotations lean right: make room past the gel's right edge for the last ones
  const lean = tilt ? Math.max(0, ...notes.map((l) => (l.x0 + l.x1) / 2 + ctx.measureText(l.text).width * Math.SQRT1_2 + afs - w)) : 0;
  const mt = Math.max(Math.round(fs * 1.5), above + Math.round(afs * 0.6)), mb = Math.round(fs * 0.5);
  mr = Math.max(mr, Math.ceil(lean));
  canvas.width = Math.ceil(w + ml + mr);
  canvas.height = h + mt + mb;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const gel = new OffscreenCanvas(w, h);
  const g = gel.getContext("2d");
  g.putImageData(greyToImageData(g, grey, w, h), 0, 0);
  ctx.drawImage(gel, ml, mt);
  ctx.fillStyle = ctx.strokeStyle = "#000000";
  ctx.lineWidth = lw;
  ctx.strokeRect(ml - lw / 2, mt - lw / 2, w + lw, h + lw); // outline round the gel
  const side = (S, x0, dir) => {
    if (!S) return;
    ctx.textAlign = dir < 0 ? "right" : "left";
    ctx.font = font;
    ctx.textBaseline = "middle";
    for (const q of S.placed) {
      const y = mt + q.y, end = x0 + dir * S.reach(q.level);
      ctx.beginPath();
      ctx.moveTo(x0, y); // flush with the inside of the outline
      ctx.lineTo(end, y);
      ctx.stroke();
      ctx.fillText(String(q.kda), end + dir * gap, y);
    }
    ctx.textBaseline = "alphabetic";
    ctx.fillText("MW (kDa)", x0 + dir * (tick + gap), mt - fs * 0.45);
  };
  side(L, ml, -1);
  side(R, ml + w, 1);

  ctx.font = afont;
  ctx.fillStyle = ctx.strokeStyle = "#000000";
  let yb = mt - Math.round(afs * 0.4); // bottom of the next row up
  if (ids) {
    ctx.font = idFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    lanes.forEach((l, i) => idLines[i].forEach((t, j) => // last line just above the gel
      ctx.fillText(t, ml + (l.x0 + l.x1) / 2, yb - (idLines[i].length - 1 - j) * Math.round(ifs * 1.15))));
    ctx.font = afont;
    yb -= ids;
  }
  if (notesH) {
    for (const l of notes) {
      const cx = ml + (l.x0 + l.x1) / 2;
      ctx.save();
      if (tilt) { // reads upwards to the right from just above the lane
        ctx.translate(cx - afs * 0.3, yb);
        ctx.rotate(-Math.PI / 4);
        ctx.textAlign = "left";
        ctx.fillText(l.text, 0, 0);
      } else {
        ctx.textAlign = "center";
        ctx.fillText(l.text, cx, yb);
      }
      ctx.restore();
    }
    yb -= notesH;
  }
  if (levels) {
    ctx.lineWidth = lw;
    ctx.textAlign = "center";
    const inset = Math.round(afs * 0.3);
    for (let lv = 0; lv < levels; lv++) {
      const barY = yb - Math.round(afs * 0.2);
      for (const g of groups.filter((q) => q.level === lv)) {
        ctx.beginPath();
        ctx.moveTo(ml + g.x0 + inset, barY);
        ctx.lineTo(ml + g.x1 - inset, barY);
        ctx.stroke();
        if (g.name) ctx.fillText(g.name, ml + (g.x0 + g.x1) / 2, barY - Math.round(afs * 0.35));
      }
      yb -= groupH;
    }
  }
}
