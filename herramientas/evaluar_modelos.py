"""
Evaluación de los modelos en la partición de prueba del dataset (sección 4.9).

Para cada modelo corre UNA sola vez:
    model.val(data=<data.yaml>, split="test", imgsz=640, plots=True)
con el mismo modo de inferencia que el nodo (edge/config.yaml). En Ultralytics 8.4,
val() usa por defecto la cabeza uno-a-muchos con NMS incluso en YOLO26; para medir
la cabeza de extremo a extremo que usa el nodo se pasa nms=False (si agnostic_nms
es true, se usa NMS agnóstico, igual que en el nodo). El modo queda en el CSV.

Salidas (por defecto en resultados/evaluacion/):
  metricas_prueba.csv                      P, R, mAP@0.5 y mAP@0.5:0.95, en total y por clase
  <modelo>_confusion_matrix.png            matriz de confusión de Ultralytics (conteos)
  <modelo>_confusion_matrix_normalized.png matriz normalizada
  <modelo>_matriz_confusion.csv            la misma matriz en números (incluye «fondo»)
  <modelo>/                                carpeta completa de Ultralytics (gráficas)

Uso (local o Google Colab):
  python herramientas/evaluar_modelos.py --data <carpeta_del_dataset>/data.yaml
El data.yaml debe estar dentro de la carpeta del dataset exportado de Roboflow
(con test/images y test/labels). Los modelos se buscan en models/.
"""
from __future__ import annotations

import argparse
import csv
import shutil
import sys
from pathlib import Path

import yaml

RAIZ = Path(__file__).resolve().parent.parent
MODELOS = ("yolo26n", "yolo26s", "yolo26m")
CLASES = ("fermentado", "violeta", "pizarroso", "mohoso")


def argumentos() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Evalúa los modelos YOLO26 en la partición de prueba")
    p.add_argument("--data", default=str(RAIZ / "data.yaml"), help="data.yaml del dataset (por defecto, el de la raíz)")
    p.add_argument("--modelos", nargs="+", default=[str(RAIZ / "models" / f"{m}.pt") for m in MODELOS],
                   help="rutas de los modelos (por defecto models/yolo26n.pt, yolo26s.pt y yolo26m.pt)")
    p.add_argument("--salida", default=str(RAIZ / "resultados" / "evaluacion"), help="carpeta de salida")
    p.add_argument("--device", default=None, help="cpu, 0 (GPU)… Por defecto, el que elija Ultralytics")
    p.add_argument("--batch", type=int, default=16)
    return p.parse_args()


def main() -> int:
    for flujo in (sys.stdout, sys.stderr):
        flujo.reconfigure(encoding="utf-8", errors="replace")
    args = argumentos()
    from ultralytics import YOLO

    cfg = yaml.safe_load((RAIZ / "edge" / "config.yaml").read_text(encoding="utf-8"))
    imgsz = int(cfg.get("imgsz", 640))
    agnostico = bool(cfg.get("agnostic_nms", False))
    args_nms = {"agnostic_nms": True} if agnostico else {"nms": False}

    data = Path(args.data).resolve()
    if not data.is_file():
        print(f"No existe el archivo {data}")
        return 1
    salida = Path(args.salida).resolve()
    salida.mkdir(parents=True, exist_ok=True)

    modelos = [Path(m) for m in args.modelos]
    faltan = [m for m in modelos if not m.is_file()]
    for m in faltan:
        print(f"AVISO: no existe {m}; se omite")
    modelos = [m for m in modelos if m.is_file()]
    if not modelos:
        print("No hay modelos que evaluar")
        return 1

    filas = []
    for ruta in modelos:
        nombre = ruta.stem
        print(f"\n=== {nombre} ===")
        modelo = YOLO(str(ruta))
        nombres = {int(i): n.strip().lower() for i, n in modelo.names.items()}
        con_e2e = hasattr(modelo.model.model[-1], "one2one_cv2")  # cabeza de extremo a extremo disponible
        modo = "nms_agnostico" if agnostico else ("extremo_a_extremo" if con_e2e else "nms")

        m = modelo.val(data=str(data), split="test", imgsz=imgsz, plots=True, batch=args.batch,
                       device=args.device, project=str(salida), name=nombre, exist_ok=True, **args_nms)
        caja = m.box
        filas.append({"modelo": nombre, "modo_inferencia": modo, "clase": "todas",
                      "P": caja.mp, "R": caja.mr, "mAP50": caja.map50, "mAP50_95": caja.map})
        for i, indice in enumerate(caja.ap_class_index):
            filas.append({"modelo": nombre, "modo_inferencia": modo, "clase": nombres[int(indice)],
                          "P": caja.p[i], "R": caja.r[i], "mAP50": caja.ap50[i], "mAP50_95": caja.ap[i]})

        # Matriz de confusión: imágenes de Ultralytics y la misma matriz en números.
        carpeta = Path(m.save_dir)
        for archivo in ("confusion_matrix.png", "confusion_matrix_normalized.png"):
            if (carpeta / archivo).is_file():
                shutil.copy2(carpeta / archivo, salida / f"{nombre}_{archivo}")
        matriz = m.confusion_matrix.matrix  # filas: predicción; columnas: etiqueta real; último índice: fondo
        etiquetas = [nombres[i] for i in range(len(nombres))] + ["fondo"]
        with open(salida / f"{nombre}_matriz_confusion.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["prediccion \\ real", *etiquetas])
            for etiqueta, fila in zip(etiquetas, matriz):
                w.writerow([etiqueta, *(int(round(v)) for v in fila)])

    with open(salida / "metricas_prueba.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["modelo", "modo_inferencia", "clase", "P", "R", "mAP50", "mAP50_95"])
        w.writeheader()
        orden = {c: i for i, c in enumerate(("todas", *CLASES))}
        for fila in sorted(filas, key=lambda x: (x["modelo"], orden.get(x["clase"], 99))):
            w.writerow({k: (round(float(v), 4) if k in ("P", "R", "mAP50", "mAP50_95") else v) for k, v in fila.items()})
    print(f"\nListo. Resultados en {salida}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
