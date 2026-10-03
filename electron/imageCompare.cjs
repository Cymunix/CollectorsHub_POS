// Compares a card scan with a catalogue photo of the card it was matched to,
// to catch colour parallels the AI reads as the base card (a Silver Border
// or Press Proof Red copy "matching" the Base item). Both images are shrunk
// to a small grid of average colours; the frame (outer ring of the grid) is
// where parallels usually differ, so it is compared on its own as well.
//
// Exposure differs between scanners and photos, so each image's colours are
// first scaled to the same average brightness ("grey world" per channel would
// also hide a coloured frame, so only overall brightness is evened out).

const GRID_W = 10
const GRID_H = 14

// image: an Electron nativeImage of the card's front (cropped, upright).
function cardSignature(image) {
  const small = image.resize({ width: GRID_W * 4, height: GRID_H * 4, quality: 'best' })
  const { width, height } = small.getSize()
  const bitmap = small.toBitmap() // BGRA
  const cells = new Float64Array(GRID_W * GRID_H * 3)
  const counts = new Uint32Array(GRID_W * GRID_H)
  let total = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const cell = Math.min(GRID_H - 1, Math.floor((y * GRID_H) / height)) * GRID_W + Math.min(GRID_W - 1, Math.floor((x * GRID_W) / width))
      const r = bitmap[offset + 2]
      const g = bitmap[offset + 1]
      const b = bitmap[offset]
      cells[cell * 3] += r
      cells[cell * 3 + 1] += g
      cells[cell * 3 + 2] += b
      counts[cell] += 1
      total += r + g + b
    }
  }
  const brightness = total / (width * height * 3) || 1
  const scale = 128 / brightness
  for (let cell = 0; cell < counts.length; cell += 1) {
    for (let channel = 0; channel < 3; channel += 1) cells[cell * 3 + channel] = (cells[cell * 3 + channel] / (counts[cell] || 1)) * scale
  }
  return cells
}

function isFrameCell(index) {
  const x = index % GRID_W
  const y = Math.floor(index / GRID_W)
  return x === 0 || y === 0 || x === GRID_W - 1 || y === GRID_H - 1
}

// 0 = identical colours; larger = more different. { overall, frame } are
// average colour distances per cell (0-255 scale).
function compareSignatures(a, b) {
  let overall = 0
  let frame = 0
  let frameCells = 0
  const cellCount = GRID_W * GRID_H
  for (let cell = 0; cell < cellCount; cell += 1) {
    const dr = a[cell * 3] - b[cell * 3]
    const dg = a[cell * 3 + 1] - b[cell * 3 + 1]
    const db = a[cell * 3 + 2] - b[cell * 3 + 2]
    const distance = Math.sqrt(dr * dr + dg * dg + db * db)
    overall += distance
    if (isFrameCell(cell)) { frame += distance; frameCells += 1 }
  }
  return { overall: overall / cellCount, frame: frame / frameCells }
}

module.exports = { cardSignature, compareSignatures }
