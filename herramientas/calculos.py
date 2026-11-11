"""
Cálculos de validación (sección 4.7). Sin dependencias externas, para que
prueba_calculos.py pueda verificarlos en cualquier equipo.
"""
from __future__ import annotations

import csv
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
RUTA_CONTEOS_EXPERTA = RAIZ / "herramientas" / "conteos_experta.csv"

# Mismo orden que edge/pipeline.py (NTE INEN 176).
CLASES = ("fermentado", "violeta", "pizarroso", "mohoso")
N_GRANOS = 100


def concordancia(experta: dict, sistema: dict, n: int = N_GRANOS) -> float:
    """C = (1 − Σ_k |n_k^E − n_k^S| / N) × 100."""
    return (1.0 - sum(abs(int(experta[c]) - int(sistema[c])) for c in CLASES) / n) * 100.0


def leer_conteos_experta(ruta: Path = RUTA_CONTEOS_EXPERTA) -> list[dict]:
    """Conteos de la experta precargados para las pruebas existentes (tabla de la sección 4.7)."""
    with open(ruta, encoding="utf-8", newline="") as f:
        filas = list(csv.DictReader(f))
    return [{"prueba": int(f["prueba"]), "video": f["video"], **{c: int(f[c]) for c in CLASES}} for f in filas]
