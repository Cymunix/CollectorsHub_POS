// Quarter-turn rotation for scan images (nativeImage has no rotate). Shared by
// the stack-scan orientation step and the local AI upright check.
const { nativeImage } = require('electron')

// Rotates a nativeImage clockwise by 0/90/180/270 degrees (BGRA bitmap copy).
function rotateNativeImage(image, degrees) {
  const turn = ((degrees % 360) + 360) % 360
  if (!turn) return image
  const { width, height } = image.getSize()
  const source = image.toBitmap()
  const target = Buffer.alloc(source.length)
  const outWidth = turn === 180 ? width : height
  const outHeight = turn === 180 ? height : width
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let tx
      let ty
      if (turn === 90) { tx = height - 1 - y; ty = x }
      else if (turn === 180) { tx = width - 1 - x; ty = height - 1 - y }
      else { tx = y; ty = width - 1 - x }
      source.copy(target, (ty * outWidth + tx) * 4, (y * width + x) * 4, (y * width + x) * 4 + 4)
    }
  }
  return nativeImage.createFromBitmap(target, { width: outWidth, height: outHeight })
}

module.exports = { rotateNativeImage }
