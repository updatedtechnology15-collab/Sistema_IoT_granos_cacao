"""
Asignación de las detecciones del cuadro representativo a la cuadrícula de
10 × 10 mitades de grano, para validar mitad por mitad (sección 4.2.7).

Regla:
1. ordenar los centros de las cajas por y y dividirlos en 10 filas de 10;
2. ordenar cada fila por x;
3. numerar fila 1–10 y columna 1–10 desde la esquina superior izquierda;
4. guardar la posición, la clase y la confianza.
Si no hay exactamente 100 detecciones, la cuadrícula es "no asignable".
"""
from __future__ import annotations

FILAS = 10
COLUMNAS = 10
NO_ASIGNABLE = "no asignable"


def asignar_cuadricula(detecciones: list[dict], filas: int = FILAS, columnas: int = COLUMNAS) -> list[dict] | str:
    if len(detecciones) != filas * columnas:
        return NO_ASIGNABLE

    centros = []
    for d in detecciones:
        x1, y1, x2, y2 = d["caja"]
        centros.append(((x1 + x2) / 2.0, (y1 + y2) / 2.0, d))

    por_y = sorted(centros, key=lambda c: c[1])
    posiciones = []
    for i in range(filas):
        fila = sorted(por_y[i * columnas:(i + 1) * columnas], key=lambda c: c[0])
        for j, (_cx, _cy, d) in enumerate(fila):
            posiciones.append({"fila": i + 1, "columna": j + 1, "clase": d["clase"], "conf": d["conf"]})
    return posiciones
