"""
Cálculos de validación (sección 4.7). Sin dependencias externas, para que
prueba_calculos.py pueda verificarlos en cualquier equipo. El servidor usa la
misma lógica en servidor/calculos.js; prueba_calculos.py verifica las dos.
"""
from __future__ import annotations

import csv
import math
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
RUTA_CONTEOS_EXPERTA = RAIZ / "herramientas" / "conteos_experta.csv"

# Mismo orden que edge/pipeline.py y servidor/calculos.js (NTE INEN 176).
CLASES = ("fermentado", "violeta", "pizarroso", "mohoso")
N_GRANOS = 100


def concordancia(experta: dict, sistema: dict, n: int = N_GRANOS) -> float:
    """C = (1 − Σ_k |n_k^E − n_k^S| / N) × 100."""
    return (1.0 - sum(abs(int(experta[c]) - int(sistema[c])) for c in CLASES) / n) * 100.0


def tasa_deteccion(total_sistema: int, n: int = N_GRANOS) -> float:
    """Tasa de detección = detecciones del sistema / N × 100."""
    return total_sistema / n * 100.0


def matriz_confusion(pares: list[tuple[str, str]]) -> list[list[int]]:
    """Matriz experta × sistema (filas: experta; columnas: sistema) en el orden de CLASES."""
    m = [[0] * len(CLASES) for _ in CLASES]
    for experta, sistema in pares:
        m[CLASES.index(experta)][CLASES.index(sistema)] += 1
    return m


def exactitud(m: list[list[int]]) -> float | None:
    """Exactitud = suma de la diagonal / N."""
    n = sum(map(sum, m))
    return sum(m[i][i] for i in range(len(m))) / n if n else None


def kappa_cohen(m: list[list[int]]) -> dict:
    """
    κ = (p_o − p_e) / (1 − p_e), con p_e = Σ_k (fila_k · columna_k) / N²
    IC 95 % = κ ± 1,96 · √(p_o (1 − p_o) / (N (1 − p_e)²)).
    Si p_e = 1, κ no está definido y se devuelve None.
    """
    k = len(m)
    n = sum(map(sum, m))
    if not n:
        return {"n": 0, "p_o": None, "p_e": None, "kappa": None, "ic95": None}
    filas = [sum(f) for f in m]
    columnas = [sum(m[i][j] for i in range(k)) for j in range(k)]
    p_o = sum(m[i][i] for i in range(k)) / n
    p_e = sum(filas[i] * columnas[i] for i in range(k)) / (n * n)
    if p_e == 1:
        return {"n": n, "p_o": p_o, "p_e": p_e, "kappa": None, "ic95": None}
    kappa = (p_o - p_e) / (1 - p_e)
    ee = math.sqrt(p_o * (1 - p_o) / (n * (1 - p_e) ** 2))
    return {"n": n, "p_o": p_o, "p_e": p_e, "kappa": kappa, "ic95": [kappa - 1.96 * ee, kappa + 1.96 * ee]}


def leer_conteos_experta(ruta: Path = RUTA_CONTEOS_EXPERTA) -> list[dict]:
    """Conteos de la experta precargados para las pruebas existentes (tabla de la sección 4.7)."""
    with open(ruta, encoding="utf-8", newline="") as f:
        filas = list(csv.DictReader(f))
    return [{"prueba": int(f["prueba"]), "video": f["video"], **{c: int(f[c]) for c in CLASES}} for f in filas]
