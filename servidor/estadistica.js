// Estadística descriptiva con las mismas definiciones que el nodo de borde
// (edge/pipeline.py): desviación estándar muestral (n − 1) y percentil con
// interpolación lineal (método por defecto de numpy.percentile).

export function media(valores) {
  if (!valores.length) return null;
  return valores.reduce((a, b) => a + b, 0) / valores.length;
}

export function desviacion(valores) {
  if (!valores.length) return null;
  if (valores.length === 1) return 0;
  const m = media(valores);
  return Math.sqrt(valores.reduce((a, v) => a + (v - m) ** 2, 0) / (valores.length - 1));
}

export function percentil(valores, p) {
  if (!valores.length) return null;
  const orden = [...valores].sort((a, b) => a - b);
  const pos = ((orden.length - 1) * p) / 100;
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < orden.length ? orden[i] + f * (orden[i + 1] - orden[i]) : orden[i];
}

export function redondear(x, decimales = 2) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const k = 10 ** decimales;
  return Math.round(x * k) / k;
}
