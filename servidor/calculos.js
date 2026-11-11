// Cálculos de validación (sección 4.7). Los mismos que herramientas/calculos.py;
// herramientas/prueba_calculos.py verifica ambas implementaciones con casos conocidos.

export const CLASES = ['fermentado', 'violeta', 'pizarroso', 'mohoso'];
export const N_GRANOS = 100;

/** C = (1 − Σ_k |n_k^E − n_k^S| / N) × 100. */
export function concordancia(experta, sistema, n = N_GRANOS) {
  const suma = CLASES.reduce((a, c) => a + Math.abs(experta[c] - sistema[c]), 0);
  return (1 - suma / n) * 100;
}

/** Tasa de detección = detecciones del sistema / N × 100. */
export function tasaDeteccion(totalSistema, n = N_GRANOS) {
  return (totalSistema / n) * 100;
}

/** Diferencia por clase, sistema − experta. */
export function diferencias(experta, sistema) {
  return Object.fromEntries(CLASES.map((c) => [c, sistema[c] - experta[c]]));
}

/** Matriz de confusión experta × sistema (filas: experta; columnas: sistema), en el orden de CLASES. */
export function matrizConfusion(pares) {
  const m = CLASES.map(() => CLASES.map(() => 0));
  for (const { experta, sistema } of pares) m[CLASES.indexOf(experta)][CLASES.indexOf(sistema)] += 1;
  return m;
}

/** Exactitud = suma de la diagonal / N. */
export function exactitud(m) {
  const n = m.flat().reduce((a, b) => a + b, 0);
  return n ? m.reduce((a, fila, i) => a + fila[i], 0) / n : null;
}

/**
 * Kappa de Cohen para una matriz cuadrada k × k:
 *   κ = (p_o − p_e) / (1 − p_e),  p_e = Σ_k (fila_k · columna_k) / N²
 *   IC 95 % = κ ± 1,96 · √(p_o (1 − p_o) / (N (1 − p_e)²))
 * Si p_e = 1 (todo en una sola clase para ambos), κ no está definido y se devuelve null.
 */
export function kappaCohen(m) {
  const k = m.length;
  const n = m.flat().reduce((a, b) => a + b, 0);
  if (!n) return { n, p_o: null, p_e: null, kappa: null, ic95: null };
  const filas = m.map((f) => f.reduce((a, b) => a + b, 0));
  const columnas = Array.from({ length: k }, (_, j) => m.reduce((a, f) => a + f[j], 0));
  const pO = m.reduce((a, f, i) => a + f[i], 0) / n;
  const pE = filas.reduce((a, f, i) => a + f * columnas[i], 0) / (n * n);
  if (pE === 1) return { n, p_o: pO, p_e: pE, kappa: null, ic95: null };
  const kappa = (pO - pE) / (1 - pE);
  const ee = Math.sqrt((pO * (1 - pO)) / (n * (1 - pE) ** 2));
  return { n, p_o: pO, p_e: pE, kappa, ic95: [kappa - 1.96 * ee, kappa + 1.96 * ee] };
}

const sinTildes = (t) => t.normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/**
 * Lee el CSV por posición (columnas fila, columna, clase_experta; separador «,» o «;»).
 * Exige las 100 posiciones de la cuadrícula de 10 × 10, cada una una sola vez.
 * Devuelve { posiciones: [{fila, columna, clase_experta}], errores: [texto] }.
 */
export function leerCsvPosiciones(texto, filas = 10, columnas = 10) {
  const errores = [];
  const lineas = String(texto ?? '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return { posiciones: [], errores: ['El CSV está vacío'] };
  const sep = lineas[0].includes(';') ? ';' : ',';
  const cabecera = lineas[0].split(sep).map(sinTildes);
  const iF = cabecera.indexOf('fila');
  const iC = cabecera.indexOf('columna');
  const iK = cabecera.indexOf('clase_experta');
  if (iF < 0 || iC < 0 || iK < 0) return { posiciones: [], errores: ['La cabecera debe tener las columnas fila, columna y clase_experta'] };

  const posiciones = [];
  const vistas = new Set();
  lineas.slice(1).forEach((linea, i) => {
    const v = linea.split(sep);
    const fila = Number(v[iF]);
    const columna = Number(v[iC]);
    const clase = sinTildes(v[iK] ?? '');
    const n = i + 2;
    if (!Number.isInteger(fila) || fila < 1 || fila > filas) errores.push(`Línea ${n}: fila debe estar entre 1 y ${filas}`);
    else if (!Number.isInteger(columna) || columna < 1 || columna > columnas) errores.push(`Línea ${n}: columna debe estar entre 1 y ${columnas}`);
    else if (!CLASES.includes(clase)) errores.push(`Línea ${n}: clase_experta debe ser ${CLASES.join(', ')}`);
    else if (vistas.has(`${fila},${columna}`)) errores.push(`Línea ${n}: la posición (${fila}, ${columna}) está repetida`);
    else {
      vistas.add(`${fila},${columna}`);
      posiciones.push({ fila, columna, clase_experta: clase });
    }
  });
  if (!errores.length && posiciones.length !== filas * columnas) {
    errores.push(`Se esperaban ${filas * columnas} posiciones y hay ${posiciones.length}`);
  }
  return { posiciones, errores: errores.slice(0, 10) };
}
