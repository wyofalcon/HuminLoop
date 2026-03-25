// src/images.js — Store clip images on disk instead of DB
// Images go to {userData}/images/{clipId}.png

const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

let imagesDir = null;

function getImagesDir() {
  if (!imagesDir) {
    imagesDir = path.join(app.getPath('userData'), 'images');
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
  }
  return imagesDir;
}

/**
 * Save a base64 data URL to disk. Returns the file path.
 * @param {string} clipId
 * @param {string} dataURL - e.g. "data:image/png;base64,iVBOR..."
 * @returns {string} file path
 */
function saveImage(clipId, dataURL) {
  if (!dataURL) return null;
  const base64 = dataURL.replace(/^data:image\/\w+;base64,/, '');
  const filePath = path.join(getImagesDir(), `${clipId}.png`);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

/**
 * Load an image from disk and return as data URL.
 * @param {string} clipId
 * @returns {string|null} data URL or null
 */
function loadImage(clipId) {
  const filePath = path.join(getImagesDir(), `${clipId}.png`);
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * Delete an image from disk.
 * @param {string} clipId
 */
function deleteImage(clipId) {
  const filePath = path.join(getImagesDir(), `${clipId}.png`);
  try { fs.unlinkSync(filePath); } catch {}
}

/**
 * Check if an image exists on disk.
 * @param {string} clipId
 * @returns {boolean}
 */
function hasImage(clipId) {
  return fs.existsSync(path.join(getImagesDir(), `${clipId}.png`));
}

/**
 * Downscale a data URL for AI processing. Reduces 1920x1080 → 800xAuto.
 * Uses Electron's nativeImage — no external deps. Returns JPEG data URL (~60-70% smaller).
 * @param {string} dataURL
 * @param {number} maxWidth
 * @returns {string} compressed data URL
 */
function compressForAI(dataURL, maxWidth = 800) {
  if (!dataURL) return null;
  const img = nativeImage.createFromDataURL(dataURL);
  const size = img.getSize();
  if (size.width <= maxWidth) {
    // Already small enough — just convert to JPEG
    return `data:image/jpeg;base64,${img.toJPEG(70).toString('base64')}`;
  }
  const scale = maxWidth / size.width;
  const resized = img.resize({ width: maxWidth, height: Math.round(size.height * scale) });
  return `data:image/jpeg;base64,${resized.toJPEG(70).toString('base64')}`;
}

module.exports = { saveImage, loadImage, deleteImage, hasImage, compressForAI };
