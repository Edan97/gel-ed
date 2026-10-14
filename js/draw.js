// Drawing: greyscale arrays to canvas pixels, and the profiles-on-gel overlay
// (port of plot_profiles_on_gel in scoping/band_peaks.py: lines and markers only).

export const COLOURS = { profile: "#2a78d6", peak: "#d62a2a", saturated: "#000000", shoulder: "#e8730c",
                         lane: "#1f4e8c" };

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
// Otherwise circles at each band's middle (b.x): ladder bands filled and labelled with
// their size (marks: per lane [{x, y, kda, ladder, i}]), other bands hollow and labelled
// with their estimated mass (b.label). drag: a ladder marker being moved {mark, x, y}.
export function drawOverlay(ctx, lanes, results, top, px, showProfiles = false, marks = null, drag = null) {
  ctx.save();
  ctx.lineJoin = "round";
  lanes.forEach(([start, end], li) => {
    drawLaneNumber(ctx, li, start, end, top, px);
    if (!showProfiles) {
      ctx.strokeStyle = COLOURS.peak;
      ctx.lineWidth = 1.8 * px;
      for (const b of results[li].bands) {
        if (b.ladderBand) continue;
        const x = b.x ?? (start + end) / 2;
        ctx.beginPath();
        ctx.arc(x, top + b.y, 6 * px, 0, 2 * Math.PI);
        ctx.stroke();
        if (b.label) label(ctx, b.label, x + 9 * px, top + b.y, px, "#222222");
      }
      for (const q of (marks && marks[li]) || []) {
        const moving = drag && drag.mark === q;
        const x = moving ? drag.x : q.x, y = top + (moving ? drag.y : q.y);
        ctx.fillStyle = COLOURS.peak;
        ctx.globalAlpha = moving ? 0.6 : 1;
        ctx.beginPath();
        ctx.arc(x, y, 6.5 * px, 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = 1;
        label(ctx, String(q.kda), x + 9.5 * px, y, px, COLOURS.peak);
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
