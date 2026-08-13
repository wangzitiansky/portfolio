import html2canvas from './html2canvas-module.js';

let exportInFlight = null;

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片生成失败')), 'image/png');
  });
}

function imageHref(image) {
  return image.getAttribute('href')
    || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    || '';
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * html2canvas 会复制 SVG，但不会可靠地携带 SVG image 的相对路径资源。
 * 导出前将卡片内的本地图片临时内嵌，确保网页与导出图使用完全相同的照片和 Logo。
 */
async function inlineSvgImages(card) {
  const images = [...card.querySelectorAll('svg image')];
  const restores = [];
  await Promise.all(images.map(async (image) => {
    const source = imageHref(image);
    if (!source || source.startsWith('data:') || source.startsWith('blob:')) return;
    let absolute;
    try { absolute = new URL(source, document.baseURI).href; } catch { return; }
    try {
      const response = await fetch(absolute, { credentials: 'same-origin', cache: 'force-cache' });
      if (!response.ok) return;
      const dataURL = await blobToDataURL(await response.blob());
      if (!dataURL) return;
      const oldHref = imageHref(image);
      image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataURL);
      image.setAttribute('href', dataURL);
      if (typeof image.decode === 'function') {
        try { await image.decode(); } catch { /* html2canvas will keep the color layer */ }
      }
      restores.push(() => {
        image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', oldHref);
        image.setAttribute('href', oldHref);
      });
    } catch {
      // 单个素材失败不应阻断整张卡片导出，保留网页中的颜色扇区和文字。
    }
  }));
  return () => restores.forEach((restore) => restore());
}

async function renderAndDownload(card, filename) {
  if (!card) throw new Error('未找到底层指数卡片');
  if (typeof html2canvas !== 'function') throw new Error('图片导出组件加载失败，请刷新页面后重试');

  const button = card.querySelector('#btn-export-index');
  const previousVisibility = button?.style.visibility;
  if (button) button.style.visibility = 'hidden';
  const restoreImages = await inlineSvgImages(card);

  try {
    const canvas = await html2canvas(card, {
      backgroundColor: '#050916',
      scale: 2,
      useCORS: true,
      allowTaint: false,
      logging: false,
      imageTimeout: 15000,
    });
    const blob = await canvasBlob(canvas);
    const url = URL.createObjectURL(blob);
    const download = document.createElement('a');
    download.href = url;
    download.download = filename || `portfolio-index-exposure-${new Date().toISOString().slice(0, 10)}.png`;
    download.style.display = 'none';
    document.body.appendChild(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } finally {
    restoreImages();
    if (button) button.style.visibility = previousVisibility || '';
  }
}

export function exportIndexCardPNG(card, { filename } = {}) {
  if (exportInFlight) return exportInFlight;
  exportInFlight = renderAndDownload(card, filename).finally(() => {
    exportInFlight = null;
  });
  return exportInFlight;
}
