"""
Benchmark de modelos (sección 4.8).

Ejecuta yolo26n, yolo26s y yolo26m en CPU y, si existe, en GPU (CUDA) sobre
Prueba_1, Prueba_2 y Prueba_3, con el mismo pipeline y los mismos parámetros
del nodo (edge/config.yaml), pero sin MQTT. Cada video es una ventana de
inspección; en cada una se descartan los cuadros de calentamiento.

Cada combinación modelo × dispositivo corre en un proceso nuevo, para que la
RSS máxima y la memoria de la GPU sean solo de esa combinación.

Uso:  python herramientas/benchmark.py
Salidas en resultados/benchmark/:
  latencias_detalle.csv, resumen.csv, conteos_y_concordancia.csv, hardware.txt
"""
from __future__ import annotations

import concurrent.futures
import csv
import logging
import multiprocessing
import statistics
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "edge"))
sys.path.insert(0, str(RAIZ / "herramientas"))

import pipeline as pl  # noqa: E402
from calculos import CLASES, concordancia, leer_conteos_experta  # noqa: E402

MODELOS = ("yolo26n", "yolo26s", "yolo26m")
MIN_CUADROS = 300          # cuadros medidos por combinación, después del calentamiento
SALIDA = RAIZ / "resultados" / "benchmark"
ETAPAS = ("lectura_ms", "preproceso_ms", "inferencia_ms", "posproceso_ms", "total_ms")

log = logging.getLogger("benchmark")


def configurar_registro() -> None:
    for flujo in (sys.stdout, sys.stderr):  # tildes legibles también al redirigir la salida a un archivo
        flujo.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")


def correr_combinacion(modelo: str, dispositivo: str, pruebas: list[dict]) -> dict:
    """Se ejecuta en un proceso aparte. Carga el modelo y procesa los tres videos."""
    configurar_registro()
    cfg = pl.cargar_config()
    detector = pl.Detector(RAIZ / "models" / f"{modelo}.pt", dispositivo, cfg)
    info = detector.info_modelo()  # antes de la primera inferencia
    log.info("%s en %s: %s parámetros, %s GFLOPs", modelo, dispositivo, f"{info['parametros']:,}", info["gflops"])

    corridas = []
    cpu_s = pared_s = 0.0
    rss_max = 0
    gpu_max = None
    for p in pruebas:
        res = pl.ejecutar_inspeccion(detector, cfg, p["video"])  # sin función de publicación: sin MQTT
        m = res.monitor
        cpu_s += m.cpu_s
        pared_s += m.pared_s
        rss_max = max(rss_max, m.rss_max)
        if m.gpu_max is not None:
            gpu_max = max(gpu_max or 0, m.gpu_max)
        corridas.append({
            "prueba": p["prueba"],
            "video": Path(p["video"]).name,
            "conteos": res.resultado["conteos"],
            "total": res.resultado["total"],
            "registros": [asdict(r) for r in res.registros],
        })
    return {
        "modelo": modelo,
        "dispositivo": dispositivo,
        **info,
        "modo_inferencia": detector.modo_inferencia,
        "corridas": corridas,
        "cpu_s": cpu_s,
        "pared_s": pared_s,
        "nucleos": res.monitor.nucleos,
        "rss_max": rss_max,
        "gpu_max": gpu_max,
    }


def ejecutar_en_proceso_nuevo(modelo: str, dispositivo: str, pruebas: list[dict]) -> dict:
    contexto = multiprocessing.get_context("spawn")
    with concurrent.futures.ProcessPoolExecutor(max_workers=1, mp_context=contexto) as ejecutor:
        return ejecutor.submit(correr_combinacion, modelo, dispositivo, pruebas).result()


def escribir_hardware(dispositivos: list[str]) -> None:
    import numpy

    hw = pl.info_hardware()
    ver = pl.info_versiones()
    lineas = [
        f"Fecha: {datetime.now():%Y-%m-%d %H:%M:%S}",
        f"CPU: {hw['cpu']}",
        f"Núcleos lógicos: {hw['nucleos_logicos']}",
        f"GPU (CUDA): {hw['gpu'] or 'no disponible'}",
        f"RAM: {hw['ram_gb']} GB",
        f"Sistema operativo: {hw['so']}",
        f"Dispositivos evaluados: {', '.join(dispositivos)}",
        f"Python: {ver['python']}",
        f"torch: {ver['torch']}",
        f"ultralytics: {ver['ultralytics']}",
        f"opencv: {ver['opencv']}",
        f"numpy: {numpy.__version__}",
    ]
    (SALIDA / "hardware.txt").write_text("\n".join(lineas) + "\n", encoding="utf-8")


def fmt(valor, decimales: int = 3):
    return "" if valor is None else round(float(valor), decimales)


def main() -> int:
    configurar_registro()
    import torch

    pruebas = leer_conteos_experta()
    faltan = [str(RAIZ / "models" / f"{m}.pt") for m in MODELOS if not (RAIZ / "models" / f"{m}.pt").is_file()]
    faltan += [str(pl.ruta_del_proyecto(p["video"])) for p in pruebas if not pl.ruta_del_proyecto(p["video"]).is_file()]
    if faltan:
        log.error("Faltan archivos:\n  %s", "\n  ".join(faltan))
        return 1

    dispositivos = ["cpu"] + (["cuda"] if torch.cuda.is_available() else [])
    SALIDA.mkdir(parents=True, exist_ok=True)
    escribir_hardware(dispositivos)

    resultados = []
    for modelo in MODELOS:
        for dispositivo in dispositivos:
            log.info("=== %s | %s ===", modelo, dispositivo)
            resultados.append(ejecutar_en_proceso_nuevo(modelo, dispositivo, pruebas))

    # --- latencias_detalle.csv: solo cuadros medidos (sin calentamiento) ---
    with open(SALIDA / "latencias_detalle.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["modelo", "dispositivo", "video", "cuadro", *ETAPAS])
        for r in resultados:
            for c in r["corridas"]:
                for reg in c["registros"]:
                    if not reg["calentamiento"]:
                        w.writerow([r["modelo"], r["dispositivo"], c["video"], reg["cuadro"],
                                    *(fmt(reg[e]) for e in ETAPAS)])

    # --- resumen.csv ---
    with open(SALIDA / "resumen.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["modelo", "parametros", "gflops", "dispositivo", "modo_inferencia", "n_cuadros",
                    "latencia_media_ms", "latencia_de_ms", "latencia_p95_ms", "fps_max",
                    "rss_max_mb", "cpu_media_pct", "gpu_mem_max_mb"])
        for r in resultados:
            totales = [reg["total_ms"] for c in r["corridas"] for reg in c["registros"] if not reg["calentamiento"]]
            if len(totales) < MIN_CUADROS:
                log.warning("%s/%s: solo %d cuadros medidos (mínimo %d)", r["modelo"], r["dispositivo"],
                            len(totales), MIN_CUADROS)
            lat = pl.resumen_latencia(totales)
            cpu_pct = 100.0 * r["cpu_s"] / r["pared_s"] / r["nucleos"]
            w.writerow([r["modelo"], r["parametros"], r["gflops"], r["dispositivo"], r["modo_inferencia"],
                        len(totales), lat["media_ms"], lat["de_ms"], lat["p95_ms"], lat["fps_max"],
                        fmt(r["rss_max"] / pl.MB, 1), fmt(cpu_pct, 1),
                        fmt(r["gpu_max"] / pl.MB if r["gpu_max"] is not None else None, 1)])

    # --- conteos_y_concordancia.csv ---
    experta = {p["prueba"]: p for p in pruebas}
    with open(SALIDA / "conteos_y_concordancia.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["modelo", "dispositivo", "prueba", *CLASES, "total", "C", "C_de"])
        resumen_c = []
        for r in resultados:
            valores_c = []
            for c in r["corridas"]:
                valor_c = concordancia(experta[c["prueba"]], c["conteos"])
                valores_c.append(valor_c)
                w.writerow([r["modelo"], r["dispositivo"], c["prueba"], *(c["conteos"][k] for k in CLASES),
                            c["total"], fmt(valor_c, 2), ""])
            de = statistics.stdev(valores_c) if len(valores_c) > 1 else 0.0
            resumen_c.append([r["modelo"], r["dispositivo"], "media ± DE", *([""] * len(CLASES)), "",
                              fmt(statistics.mean(valores_c), 2), fmt(de, 2)])
        w.writerows(resumen_c)

    log.info("Listo. Archivos en %s", SALIDA)
    return 0


if __name__ == "__main__":
    sys.exit(main())
