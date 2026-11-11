/**
 * Imagens do chat: reduz no navegador (foto de celular de 5–12 MB vira poucas centenas de KB,
 * já na orientação certa) e envia para POST /api/imagens, que devolve o id usado na pergunta.
 */

/** Reduz para no máximo `max` px no maior lado, em JPEG; se algo falhar, envia o arquivo original. */
export async function reduzirImagem(arquivo: File, max = 2000): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
    const escala = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (escala === 1 && arquivo.size < 2_500_000) { bmp.close(); return arquivo; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * escala);
    canvas.height = Math.round(bmp.height * escala);
    const ctx = canvas.getContext('2d');
    if (!ctx) { bmp.close(); return arquivo; }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b ?? arquivo), 'image/jpeg', 0.88));
  } catch {
    return arquivo;
  }
}

export async function enviarImagem(arquivo: File): Promise<string> {
  const corpo = new FormData();
  corpo.append('imagem', await reduzirImagem(arquivo), arquivo.name || 'imagem.jpg');
  const r = await fetch('/api/imagens', { method: 'POST', credentials: 'same-origin', body: corpo });
  const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!r.ok || !j.id) throw new Error(j.error || `falha no envio (HTTP ${r.status})`);
  return j.id;
}
