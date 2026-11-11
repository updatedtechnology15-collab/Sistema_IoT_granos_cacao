"""
Verifica los cálculos de validación con casos conocidos (criterio de aceptación).

Prueba las dos implementaciones con los mismos casos:
  - herramientas/calculos.py (Python: benchmark y análisis);
  - servidor/calculos.js     (Node.js: API POST /api/validaciones), si Node está instalado.

Uso:  python herramientas/prueba_calculos.py      (código de salida 0 = todo correcto)
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "herramientas"))

import calculos as py  # noqa: E402

TOL = 1e-4


def conteos(fermentado, violeta, pizarroso, mohoso):
    return {"fermentado": fermentado, "violeta": violeta, "pizarroso": pizarroso, "mohoso": mohoso}


def matriz_4x4(m2x2):
    """Inserta una matriz 2 × 2 en la esquina de una 4 × 4 (las clases vacías no cambian κ)."""
    (a, b), (c, d) = m2x2
    return [[a, b, 0, 0], [c, d, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]


# ---------------------------------------------------------------------------
# Casos de concordancia C. Orden del enunciado: fermentado, mohoso, violeta, pizarroso.
# ---------------------------------------------------------------------------
CASOS_C = [
    ("Criterio de aceptación: E (36,3,19,42) vs S (37,3,17,43) → 96",
     conteos(fermentado=36, mohoso=3, violeta=19, pizarroso=42),
     conteos(fermentado=37, mohoso=3, violeta=17, pizarroso=43), 96.0),
    ("Conteos idénticos → 100",
     conteos(36, 19, 42, 3), conteos(36, 19, 42, 3), 100.0),
    ("Sistema detecta 90 de 100: |6|+|2|+|2|+|0| = 10 → 90",
     conteos(36, 19, 42, 3), conteos(30, 17, 40, 3), 90.0),
    ("Prueba 3 de la experta vs un sistema que confunde 10 fermentados con violetas → 80",
     conteos(48, 9, 32, 11), conteos(38, 19, 32, 11), 80.0),
]

# ---------------------------------------------------------------------------
# Casos de kappa de Cohen (κ e IC 95 %).
# ---------------------------------------------------------------------------
# Ejemplo clásico 2 × 2 (Wikipedia, «Cohen's kappa»): p_o = 0,70; p_e = 0,50; κ = 0,40.
#   EE = √(0,7·0,3 / (50·0,5²)) = 0,129615 → IC = 0,40 ± 0,254045.
# Mismo artículo: [[45,15],[25,15]] → κ = 0,1304 y [[25,35],[5,35]] → κ = 0,2593.
# Caso 4 × 4 calculado a mano (N = 100, diagonal 89, márgenes 36/19/42/3):
#   p_o = 0,89; p_e = (36² + 19² + 42² + 3²) / 100² = 0,343; κ = 0,547 / 0,657 = 0,832572
#   EE = √(0,89·0,11 / (100·0,657²)) = 0,047624 → IC = [0,739229; 0,925915].
CASOS_KAPPA = [
    ("Wikipedia 2×2 [[20,5],[10,15]] → κ = 0,4000", matriz_4x4([[20, 5], [10, 15]]),
     {"kappa": 0.4, "p_o": 0.7, "p_e": 0.5, "ic95": [0.4 - 0.254045, 0.4 + 0.254045]}),
    ("Wikipedia 2×2 [[45,15],[25,15]] → κ = 0,1304", matriz_4x4([[45, 15], [25, 15]]),
     {"kappa": 0.130435}),
    ("Wikipedia 2×2 [[25,35],[5,35]] → κ = 0,2593", matriz_4x4([[25, 35], [5, 35]]),
     {"kappa": 0.259259}),
    ("4×4 a mano (diagonal 89, márgenes 36/19/42/3) → κ = 0,8326",
     [[33, 2, 1, 0], [1, 16, 2, 0], [2, 1, 38, 1], [0, 0, 1, 2]],
     {"kappa": 0.832572, "p_o": 0.89, "p_e": 0.343, "ic95": [0.739229, 0.925915], "exactitud": 0.89}),
    ("Acuerdo perfecto → κ = 1 e IC [1, 1]",
     [[36, 0, 0, 0], [0, 19, 0, 0], [0, 0, 42, 0], [0, 0, 0, 3]],
     {"kappa": 1.0, "ic95": [1.0, 1.0], "exactitud": 1.0}),
    ("Todo en una clase para ambos (p_e = 1) → κ no definido",
     [[100, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
     {"kappa": None}),
]


def cerca(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(b, list):
        return isinstance(a, list) and len(a) == len(b) and all(cerca(x, y) for x, y in zip(a, b))
    return abs(a - b) <= TOL


def resultados_python() -> dict:
    return {
        "C": [py.concordancia(e, s) for _, e, s, _ in CASOS_C],
        "kappa": [{**py.kappa_cohen(m), "exactitud": py.exactitud(m)} for _, m, _ in CASOS_KAPPA],
        "tasa": py.tasa_deteccion(67),
    }


def resultados_node() -> dict | None:
    node = shutil.which("node")
    if not node:
        return None
    url = (RAIZ / "servidor" / "calculos.js").as_uri()
    codigo = (
        "import fs from 'node:fs';"
        f"import * as c from '{url}';"
        "const d = JSON.parse(fs.readFileSync(0, 'utf8'));"
        "const k = d.matrices.map((m) => ({ ...c.kappaCohen(m), exactitud: c.exactitud(m) }));"
        "console.log(JSON.stringify({ C: d.c.map(([e, s]) => c.concordancia(e, s)), kappa: k, tasa: c.tasaDeteccion(67) }));"
    )
    entrada = json.dumps({"c": [[e, s] for _, e, s, _ in CASOS_C], "matrices": [m for _, m, _ in CASOS_KAPPA]})
    salida = subprocess.run([node, "--input-type=module", "-e", codigo], input=entrada, capture_output=True,
                            text=True, encoding="utf-8", check=True)
    return json.loads(salida.stdout)


def verificar(nombre: str, r: dict) -> int:
    fallas = 0
    print(f"\n=== {nombre} ===")
    for (desc, _, _, esperado), obtenido in zip(CASOS_C, r["C"]):
        ok = cerca(obtenido, esperado)
        fallas += not ok
        print(f"  [{'PASA' if ok else 'FALLA'}] C: {desc}  (obtenido {obtenido:.4f})")
    for (desc, _, esperado), obtenido in zip(CASOS_KAPPA, r["kappa"]):
        malos = [k for k, v in esperado.items() if not cerca(obtenido.get(k), v)]
        fallas += bool(malos)
        k = obtenido.get("kappa")
        detalle = f"κ = {k:.6f}" if k is not None else "κ = no definido"
        if obtenido.get("ic95"):
            detalle += f", IC 95 % [{obtenido['ic95'][0]:.6f}; {obtenido['ic95'][1]:.6f}]"
        print(f"  [{'PASA' if not malos else 'FALLA ' + ', '.join(malos)}] {desc}  ({detalle})")
    ok = cerca(r["tasa"], 67.0)
    fallas += not ok
    print(f"  [{'PASA' if ok else 'FALLA'}] Tasa de detección: 67 detecciones de 100 → 67 %  (obtenido {r['tasa']})")
    return fallas


def main() -> int:
    for flujo in (sys.stdout, sys.stderr):
        flujo.reconfigure(encoding="utf-8", errors="replace")
    fallas = verificar("Python (herramientas/calculos.py)", resultados_python())
    try:
        r_node = resultados_node()
    except subprocess.CalledProcessError as e:
        print(f"\nNo se pudo ejecutar servidor/calculos.js con Node:\n{e.stderr}")
        return 1
    if r_node is None:
        print("\n(Node.js no está instalado: se omite la verificación de servidor/calculos.js)")
    else:
        fallas += verificar("Node.js (servidor/calculos.js)", r_node)
    print(f"\n{'TODO CORRECTO' if fallas == 0 else f'{fallas} VERIFICACIÓN(ES) FALLARON'}")
    return 0 if fallas == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
