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
export function drawOverlay(ctx, lanes, results, top, px, showProfiles = false, marks = null, drag = null, picks = null) {
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
        ctx.globalAlpha = moving ? 0.6 : 1;
        ctx.beginPath();
        ctx.arc(x, y, 4 * px, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
        label(ctx, String(q.kda), x + 7 * px, y, px, COLOURS.peak);
      }
      return;
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
// Drawn at the gel's own resolution; text and lines scale with its height.
export function renderFigure(canvas, grey, w, h, left, right) {
  const fs = Math.max(14, Math.round(h / 30));          // size labels
  const kfs = Math.round(fs * 1.3);                      // "kDa"
  const lw = 2 * Math.max(1, fs / 10);                   // lines and outline
  const tick = Math.round(fs * 0.8), gap = Math.round(fs * 0.35), sep = fs * 1.3; // sep: closest labels on one level
  const ctx = canvas.getContext("2d");
  const font = `${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const kfont = `bold ${kfs}px system-ui, -apple-system, "Segoe UI", sans-serif`;
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
    ctx.font = kfont;
    const kw = ctx.measureText("kDa").width;
    return { placed, reach, width: Math.ceil(Math.max(reach(levels - 1) + gap + textW, kw) + fs * 0.6) };
  };
  const L = layout(left), R = layout(right);
  const ml = L ? L.width : Math.round(fs * 0.6), mr = R ? R.width : Math.round(fs * 0.6);
  const mt = Math.round(kfs * 1.7), mb = Math.round(fs * 0.8);
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
      ctx.moveTo(x0 - dir * (lw / 2), y);
      ctx.lineTo(end, y);
      ctx.stroke();
      ctx.fillText(String(q.kda), end + dir * gap, y);
    }
    ctx.font = kfont;
    ctx.textBaseline = "alphabetic";
    ctx.fillText("kDa", x0 + dir * (tick + gap), mt - kfs * 0.5);
  };
  side(L, ml, -1);
  side(R, ml + w, 1);
}
