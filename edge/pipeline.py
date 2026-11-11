"""
Pipeline de inferencia compartido por el nodo de borde (edge/main.py) y por el
benchmark (herramientas/benchmark.py).

Este módulo no conoce MQTT: el nodo le entrega una función de publicación y el
benchmark no le entrega ninguna. Así ambos miden exactamente el mismo proceso.

Reglas que fija este módulo (sección 4.2 del documento de requisitos):
- Se procesa 1 de cada round(fps_fuente / fps_operacion) cuadros; en los
  cuadros que se saltan se usa cap.grab().
- Archivo de video: el tiempo es tiempo del video (índice de cuadro / fps).
  Cámara o URL: el tiempo es tiempo de reloj.
- Conteo de la inspección: mediana por clase de los conteos de todos los
  cuadros procesados, redondeada a entero (0.5 hacia arriba).
- Cuadro representativo: el de menor distancia L1 entre su vector de conteos y
  el vector de medianas redondeadas; si hay empate, el primero en el tiempo.
- Latencia: se descartan los primeros `cuadros_calentamiento` cuadros.
"""
from __future__ import annotations

import base64
import copy
import csv
import logging
import math
import platform
import sys
import time
import unicodedata
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
import psutil
import yaml

from cuadricula import asignar_cuadricula

log = logging.getLogger("pipeline")

RAIZ = Path(__file__).resolve().parent.parent
RUTA_CONFIG = RAIZ / "edge" / "config.yaml"

# Orden canónico de las clases en todo el sistema (el de la NTE INEN 176).
CLASES = ("fermentado", "violeta", "pizarroso", "mohoso")

# Colores BGR de las cajas, uno por clase: los mismos del tablero web
# (paleta validada para daltonismo). Sobre el amarillo el texto va en negro.
COLORES = {
    "fermentado": (52, 104, 235),   # #eb6834 anaranjado
    "violeta": (214, 80, 98),       # #6250d6 violeta
    "pizarroso": (0, 161, 237),     # #eda100 amarillo
    "mohoso": (0, 131, 0),          # #008300 verde
}
TEXTO_OSCURO = {"pizarroso"}

MB = 2 ** 20  # los tamaños de memoria se informan en MB de 2^20 bytes


# ---------------------------------------------------------------------------
# Utilidades generales
# ---------------------------------------------------------------------------
def ahora_iso() -> str:
    """Marca de tiempo UTC en ISO 8601 con milisegundos, p. ej. 2026-11-09T23:06:00.123Z."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def cargar_config(ruta: Path = RUTA_CONFIG) -> dict:
    """Lee edge/config.yaml. Los secretos no van aquí, sino en .env."""
    with open(ruta, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    if not isinstance(cfg, dict):
        raise ValueError(f"El archivo de configuración {ruta} está vacío o mal formado")
    return cfg


def ruta_del_proyecto(valor: str | Path) -> Path:
    """Resuelve una ruta relativa: primero desde la carpeta actual y, si no existe, desde la raíz del proyecto."""
    ruta = Path(valor)
    if ruta.is_absolute() or ruta.exists():
        return ruta.resolve()
    return (RAIZ / ruta).resolve()


def interpretar_fuente(fuente) -> tuple[int | str, bool]:
    """
    Convierte el valor de `fuente` en el argumento de cv2.VideoCapture.
    Devuelve (valor, es_archivo). Un número es un índice de cámara; un texto con
    "://" es una URL (se trata como fuente en vivo); cualquier otro texto es la
    ruta de un archivo de video.
    """
    if isinstance(fuente, int):
        return fuente, False
    texto = str(fuente).strip()
    if texto.isdigit():
        return int(texto), False
    if "://" in texto:
        return texto, False
    ruta = ruta_del_proyecto(texto)
    if not ruta.is_file():
        raise FileNotFoundError(f"No existe el archivo de video: {ruta}")
    return str(ruta), True


def resolver_dispositivo(pedido: str) -> str:
    """'auto' usa CUDA si está disponible; si no, la CPU. Devuelve 'cpu' o 'cuda'."""
    import torch

    pedido = str(pedido).strip().lower()
    hay_cuda = torch.cuda.is_available()
    if pedido == "auto":
        return "cuda" if hay_cuda else "cpu"
    if pedido == "cuda":
        if not hay_cuda:
            raise RuntimeError("config.yaml pide dispositivo: cuda, pero torch no detecta CUDA en este equipo")
        return "cuda"
    if pedido == "cpu":
        return "cpu"
    raise ValueError(f"dispositivo no válido: {pedido!r} (use auto, cpu o cuda)")


def _normalizar(nombre: str) -> str:
    sin_tildes = unicodedata.normalize("NFKD", nombre).encode("ascii", "ignore").decode()
    return sin_tildes.strip().lower()


# ---------------------------------------------------------------------------
# Detector YOLO26
# ---------------------------------------------------------------------------
class Detector:
    """Carga un modelo YOLO26, ejecuta la inferencia y aplica el filtro de área."""

    def __init__(self, ruta_modelo: str | Path, dispositivo: str, cfg: dict):
        from ultralytics import YOLO

        self.ruta = ruta_del_proyecto(ruta_modelo)
        if not self.ruta.is_file():
            raise FileNotFoundError(f"No existe el modelo: {self.ruta}")
        self.nombre = self.ruta.stem
        self.dispositivo = dispositivo                      # 'cpu' o 'cuda'
        self._dispositivo_yolo = "0" if dispositivo == "cuda" else "cpu"
        self.imgsz = int(cfg["imgsz"])
        self.conf = float(cfg["conf"])
        self.agnostic_nms = bool(cfg.get("agnostic_nms", False))
        self.area_min = float(cfg["area_min_frac"])
        self.area_max = float(cfg["area_max_frac"])

        # En Ultralytics 8.4, predict() usa por defecto la cabeza uno-a-muchos con NMS
        # incluso en YOLO26; la cabeza de extremo a extremo (sin NMS) se pide con
        # nms=False. Si el modelo no la tiene (p. ej. YOLO11), Ultralytics aplica su
        # NMS por clase. Con agnostic_nms: true se usa NMS agnóstico a la clase.
        self._args_nms = {"agnostic_nms": True} if self.agnostic_nms else {"nms": False}

        self.modelo = YOLO(str(self.ruta))
        self.clase_por_indice = self._mapear_clases(self.modelo.names)
        self.modo_inferencia: str | None = None  # se fija después de la primera inferencia

    @staticmethod
    def _mapear_clases(nombres: dict) -> dict[int, str]:
        """Relaciona los índices del modelo con las cuatro clases del sistema (sin importar mayúsculas)."""
        mapa = {}
        for indice, nombre in nombres.items():
            clase = _normalizar(nombre)
            if clase not in CLASES:
                raise ValueError(
                    f"La clase {nombre!r} del modelo no es una de {CLASES}. Clases del modelo: {nombres}"
                )
            mapa[int(indice)] = clase
        return mapa

    def info_modelo(self) -> dict:
        """Parámetros y GFLOPs (a imgsz) según model.info(). Llamar antes de la primera inferencia (que fusiona capas)."""
        # Ultralytics solo devuelve la tupla con verbose=True (además imprime el resumen).
        _capas, parametros, _gradientes, gflops = self.modelo.info(verbose=True, imgsz=self.imgsz)
        return {"parametros": int(parametros), "gflops": round(float(gflops), 2)}

    def _detectar_modo(self) -> str:
        """Modo de inferencia efectivo (lo que Ultralytics hizo de verdad), leído del predictor ya configurado."""
        backend = getattr(getattr(self.modelo, "predictor", None), "model", None)
        if getattr(backend, "end2end", False):
            return "extremo_a_extremo"
        return "nms_agnostico" if self.agnostic_nms else "nms"

    def detectar(self, cuadro: np.ndarray) -> tuple[list[dict], dict]:
        """
        Ejecuta la inferencia sobre un cuadro BGR y aplica el filtro de área.
        Devuelve (detecciones, tiempos) con tiempos en ms tomados de results[0].speed.
        """
        resultado = self.modelo.predict(
            cuadro,
            imgsz=self.imgsz,
            conf=self.conf,
            device=self._dispositivo_yolo,
            verbose=False,
            **self._args_nms,
        )[0]
        if self.modo_inferencia is None:
            self.modo_inferencia = self._detectar_modo()

        alto, ancho = cuadro.shape[:2]
        area_cuadro = float(alto * ancho)
        cajas = resultado.boxes
        xyxy = cajas.xyxy.cpu().numpy()
        confianzas = cajas.conf.cpu().numpy()
        indices = cajas.cls.cpu().numpy().astype(int)

        detecciones = []
        for (x1, y1, x2, y2), conf, indice in zip(xyxy, confianzas, indices):
            fraccion = (x2 - x1) * (y2 - y1) / area_cuadro
            if fraccion < self.area_min or fraccion > self.area_max:
                continue  # filtro de área: caja demasiado pequeña o demasiado grande
            detecciones.append({
                "clase": self.clase_por_indice[int(indice)],
                "conf": round(float(conf), 4),
                "caja": [round(float(v), 1) for v in (x1, y1, x2, y2)],
            })

        velocidad = resultado.speed  # ms medidos por Ultralytics
        tiempos = {
            "preproceso_ms": float(velocidad.get("preprocess") or 0.0),
            "inferencia_ms": float(velocidad.get("inference") or 0.0),
            "posproceso_ms": float(velocidad.get("postprocess") or 0.0),
        }
        return detecciones, tiempos


def contar(detecciones: list[dict]) -> dict[str, int]:
    conteos = {c: 0 for c in CLASES}
    for d in detecciones:
        conteos[d["clase"]] += 1
    return conteos


# ---------------------------------------------------------------------------
# Imagen
# ---------------------------------------------------------------------------
def dibujar_detecciones(imagen: np.ndarray, detecciones: list[dict], escala_cajas: float = 1.0) -> np.ndarray:
    """Dibuja cada caja con su clase y confianza (OpenCV). No modifica la imagen original."""
    salida = imagen.copy()
    alto, ancho = salida.shape[:2]
    lado = min(alto, ancho)
    grosor = max(1, round(lado / 540))
    escala_texto = max(0.35, lado / 2200)
    grosor_texto = max(1, grosor - 1)
    fuente = cv2.FONT_HERSHEY_SIMPLEX
    for d in detecciones:
        x1, y1, x2, y2 = (int(round(v * escala_cajas)) for v in d["caja"])
        color = COLORES[d["clase"]]
        cv2.rectangle(salida, (x1, y1), (x2, y2), color, grosor)
        texto = f'{d["clase"]} {d["conf"]:.2f}'
        (tw, th), base = cv2.getTextSize(texto, fuente, escala_texto, grosor_texto)
        y_texto = max(th + base, y1)
        cv2.rectangle(salida, (x1, y_texto - th - base), (x1 + tw, y_texto), color, -1)
        tinta = (11, 11, 11) if d["clase"] in TEXTO_OSCURO else (255, 255, 255)
        cv2.putText(salida, texto, (x1, y_texto - base), fuente, escala_texto, tinta, grosor_texto, cv2.LINE_AA)
    return salida


def codificar_jpeg(imagen: np.ndarray, calidad: int) -> bytes:
    ok, buffer = cv2.imencode(".jpg", imagen, [cv2.IMWRITE_JPEG_QUALITY, int(calidad)])
    if not ok:
        raise RuntimeError("OpenCV no pudo codificar la imagen en JPEG")
    return buffer.tobytes()


def cuadro_vivo(cuadro: np.ndarray, detecciones: list[dict], lado_max: int, calidad: int) -> tuple[str, int, int]:
    """Reduce el cuadro a `lado_max` píxeles de lado mayor, dibuja las cajas y lo codifica. Devuelve (base64, ancho, alto)."""
    alto, ancho = cuadro.shape[:2]
    factor = min(1.0, lado_max / max(alto, ancho))
    if factor < 1.0:
        cuadro = cv2.resize(cuadro, (round(ancho * factor), round(alto * factor)), interpolation=cv2.INTER_AREA)
    anotado = dibujar_detecciones(cuadro, detecciones, escala_cajas=factor)
    jpeg = codificar_jpeg(anotado, calidad)
    return base64.b64encode(jpeg).decode("ascii"), anotado.shape[1], anotado.shape[0]


# ---------------------------------------------------------------------------
# Estadística
# ---------------------------------------------------------------------------
def mediana_conteos(matriz: np.ndarray) -> np.ndarray:
    """Mediana por columna (clase), redondeada a entero con 0.5 hacia arriba."""
    return np.floor(np.median(matriz, axis=0) + 0.5).astype(int)


def resumen_latencia(valores_ms) -> dict:
    """Media, desviación estándar muestral (n − 1), percentil 95 (interpolación lineal) y fps máximo = 1000 / media."""
    v = np.asarray(list(valores_ms), dtype=float)
    if v.size == 0:
        return {"media_ms": None, "de_ms": None, "p95_ms": None, "fps_max": None}
    media = float(v.mean())
    return {
        "media_ms": round(media, 2),
        "de_ms": round(float(v.std(ddof=1)) if v.size > 1 else 0.0, 2),
        "p95_ms": round(float(np.percentile(v, 95)), 2),
        "fps_max": round(1000.0 / media, 2) if media > 0 else None,
    }


# ---------------------------------------------------------------------------
# Recursos y entorno
# ---------------------------------------------------------------------------
class MonitorRecursos:
    """
    RSS máxima del proceso (muestreada después de cada cuadro), CPU media del
    proceso y memoria máxima reservada por PyTorch en la GPU.
    La CPU media se expresa como % de la capacidad total del equipo
    (100 % = todos los núcleos lógicos ocupados) y se mide después del calentamiento.
    """

    def __init__(self, usa_cuda: bool):
        self.proceso = psutil.Process()
        self.nucleos = psutil.cpu_count(logical=True) or 1
        self.usa_cuda = usa_cuda

    def _cpu_s(self) -> float:
        t = self.proceso.cpu_times()
        return t.user + t.system

    def iniciar(self) -> None:
        self.rss_max = self.proceso.memory_info().rss
        if self.usa_cuda:
            import torch
            torch.cuda.reset_peak_memory_stats()
        self.iniciar_cpu()

    def iniciar_cpu(self) -> None:
        self.cpu_inicial_s = self._cpu_s()
        self.pared_inicial_s = time.perf_counter()

    def muestrear(self) -> None:
        self.rss_max = max(self.rss_max, self.proceso.memory_info().rss)

    def cerrar(self) -> None:
        self.cpu_s = self._cpu_s() - self.cpu_inicial_s
        self.pared_s = time.perf_counter() - self.pared_inicial_s
        self.gpu_max = None
        if self.usa_cuda:
            import torch
            self.gpu_max = torch.cuda.max_memory_reserved()

    def resultado(self) -> dict:
        cpu_pct = 100.0 * self.cpu_s / self.pared_s / self.nucleos if self.pared_s > 0 else None
        return {
            "rss_max_mb": round(self.rss_max / MB, 1),
            "cpu_media_pct": round(cpu_pct, 1) if cpu_pct is not None else None,
            "gpu_mem_max_mb": round(self.gpu_max / MB, 1) if self.gpu_max is not None else None,
        }


def nombre_cpu() -> str:
    if sys.platform == "win32":
        try:
            import winreg
            clave = r"HARDWARE\DESCRIPTION\System\CentralProcessor\0"
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, clave) as k:
                return str(winreg.QueryValueEx(k, "ProcessorNameString")[0]).strip()
        except OSError:
            pass
    elif sys.platform.startswith("linux"):
        try:
            with open("/proc/cpuinfo", encoding="utf-8") as f:
                for linea in f:
                    if linea.startswith("model name"):
                        return linea.split(":", 1)[1].strip()
        except OSError:
            pass
    return platform.processor() or platform.machine()


def info_hardware() -> dict:
    import torch

    return {
        "cpu": nombre_cpu(),
        "nucleos_logicos": psutil.cpu_count(logical=True),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "ram_gb": round(psutil.virtual_memory().total / 2 ** 30, 1),
        "so": platform.platform(),
    }


def info_versiones() -> dict:
    import torch
    import ultralytics

    return {
        "python": platform.python_version(),
        "torch": torch.__version__,
        "ultralytics": ultralytics.__version__,
        "opencv": cv2.__version__,
    }


# ---------------------------------------------------------------------------
# Inspección
# ---------------------------------------------------------------------------
@dataclass
class RegistroCuadro:
    """Datos de un cuadro procesado (una fila de los CSV)."""
    cuadro: int            # número de cuadro procesado, desde 0
    indice_fuente: int     # índice del cuadro en la fuente
    t_s: float             # tiempo del video (archivo) o de reloj (en vivo)
    calentamiento: bool
    fermentado: int
    violeta: int
    pizarroso: int
    mohoso: int
    total_detecciones: int
    lectura_ms: float
    preproceso_ms: float
    inferencia_ms: float
    posproceso_ms: float
    publicacion_ms: float
    total_ms: float

    def vector(self) -> tuple[int, ...]:
        return tuple(getattr(self, c) for c in CLASES)


@dataclass
class ResultadoInspeccion:
    resultado: dict                 # cuerpo del mensaje `inspeccion` (sin identificadores)
    registros: list[RegistroCuadro]
    monitor: MonitorRecursos


# publicar(cuadro=k, t_s=..., imagen=..., conteos=..., detecciones=..., latencia_ms=...)
FuncionPublicar = Callable[..., None]


def ejecutar_inspeccion(
    detector: Detector,
    cfg: dict,
    fuente,
    ventana_s: float | None = None,
    publicar: FuncionPublicar | None = None,
) -> ResultadoInspeccion:
    """
    Procesa una ventana de `ventana_s` segundos de la fuente y calcula el resultado
    de la inspección. Si `publicar` no es None, se llama una vez por cuadro
    procesado y su duración se mide como la etapa de publicación.
    """
    ventana_s = float(ventana_s if ventana_s is not None else cfg["ventana_s"])
    n_calentamiento = int(cfg.get("cuadros_calentamiento", 20))
    valor, es_archivo = interpretar_fuente(fuente)

    cap = cv2.VideoCapture(valor)
    if not cap.isOpened():
        raise RuntimeError(f"No se pudo abrir la fuente de video: {fuente}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    fps_informado = bool(fps and math.isfinite(fps) and fps > 0)
    if not fps_informado:
        fps = float(cfg.get("fps_fuente_defecto", 30))
    paso = max(1, round(fps / float(cfg["fps_operacion"])))
    log.info("Fuente %s | %s | fps %.2f%s | se procesa 1 de cada %d cuadros | ventana %.1f s",
             fuente, "archivo" if es_archivo else "en vivo", fps, "" if fps_informado else " (supuesto)",
             paso, ventana_s)

    monitor = MonitorRecursos(detector.dispositivo == "cuda")
    registros: list[RegistroCuadro] = []
    # Primer cuadro de cada vector de conteos distinto. Cuadros con el mismo
    # vector tienen la misma distancia a la mediana y gana el primero, así que
    # basta guardar la primera aparición de cada vector.
    candidatos: dict[tuple[int, ...], tuple[RegistroCuadro, np.ndarray, list[dict]]] = {}

    inicio = ahora_iso()
    monitor.iniciar()
    t_inicio = time.perf_counter()
    k = 0             # cuadros procesados
    indice = -1       # último índice leído de la fuente
    try:
        while True:
            # --- ¿sigue abierta la ventana? ---
            if es_archivo:
                if (k * paso) / fps >= ventana_s:
                    break
            elif time.perf_counter() - t_inicio >= ventana_s:
                break
            if k == n_calentamiento:
                monitor.iniciar_cpu()  # la CPU media se mide después del calentamiento

            # --- saltar cuadros con cap.grab() ---
            fin_fuente = False
            if k > 0:
                for _ in range(paso - 1):
                    if not cap.grab():
                        fin_fuente = True
                        break
                    indice += 1
            if fin_fuente:
                break

            # --- lectura ---
            t0 = time.perf_counter()
            ok, cuadro = cap.read()
            t1 = time.perf_counter()
            if not ok:
                break
            indice += 1
            t_s = indice / fps if es_archivo else t0 - t_inicio

            # --- preproceso, inferencia y posproceso (Ultralytics) + filtro de área y conteo ---
            detecciones, tiempos = detector.detectar(cuadro)
            conteos = contar(detecciones)
            t2 = time.perf_counter()

            # --- publicación ---
            if publicar is not None:
                publicar(cuadro=k, t_s=t_s, imagen=cuadro, conteos=conteos,
                         detecciones=detecciones, latencia_ms=(t2 - t0) * 1000.0)
            t3 = time.perf_counter()

            registro = RegistroCuadro(
                cuadro=k, indice_fuente=indice, t_s=round(t_s, 3), calentamiento=k < n_calentamiento,
                **conteos, total_detecciones=len(detecciones),
                lectura_ms=(t1 - t0) * 1000.0, **tiempos,
                publicacion_ms=(t3 - t2) * 1000.0 if publicar is not None else 0.0,
                total_ms=(t3 - t0) * 1000.0,
            )
            registros.append(registro)
            candidatos.setdefault(registro.vector(), (registro, cuadro, detecciones))
            monitor.muestrear()
            if k % 25 == 0:
                log.info("cuadro %d | t=%.1f s | %d detecciones | %.1f ms", k, t_s, len(detecciones),
                         registro.total_ms)
            k += 1
    finally:
        cap.release()
    monitor.cerrar()
    fin = ahora_iso()

    if not registros:
        raise RuntimeError(f"La fuente {fuente} no entregó ningún cuadro")

    # --- conteo por mediana ---
    matriz = np.array([r.vector() for r in registros])
    mediana = mediana_conteos(matriz)
    conteos = {c: int(n) for c, n in zip(CLASES, mediana)}
    total = int(sum(conteos.values()))
    porcentajes = {c: round(100.0 * n / total, 2) if total else 0.0 for c, n in conteos.items()}

    # --- cuadro representativo: menor distancia L1 a la mediana; empate -> el primero ---
    rep, imagen_rep, detecciones_rep = min(
        candidatos.values(),
        key=lambda item: (int(np.abs(np.array(item[0].vector()) - mediana).sum()), item[0].cuadro),
    )
    anotada = dibujar_detecciones(imagen_rep, detecciones_rep)
    jpeg = codificar_jpeg(anotada, int(cfg.get("calidad_jpeg_representativo", 85)))

    latencias = [r.total_ms for r in registros if not r.calentamiento]
    parametros = copy.deepcopy(cfg)
    parametros["fuente"] = str(fuente)
    parametros["ventana_s"] = ventana_s

    resultado = {
        "inicio": inicio,
        "fin": fin,
        "ventana_s": ventana_s,
        "fps_operacion": cfg["fps_operacion"],
        "fuente": str(fuente),
        "tipo_fuente": "archivo" if es_archivo else "en_vivo",
        "fps_fuente": round(float(fps), 3),
        "paso": paso,
        "n_cuadros": len(registros),
        "n_cuadros_latencia": len(latencias),
        "conteos": conteos,
        "total": total,
        "porcentajes": porcentajes,
        "latencia": resumen_latencia(latencias),
        "recursos": monitor.resultado(),
        "modelo": detector.nombre,
        "dispositivo": detector.dispositivo,
        "hardware": info_hardware(),
        "versiones": info_versiones(),
        "parametros": parametros,
        "modo_inferencia": detector.modo_inferencia,
        "cuadro_representativo": {"cuadro": rep.cuadro, "indice_fuente": rep.indice_fuente, "t_s": rep.t_s,
                                  "distancia_l1": int(np.abs(np.array(rep.vector()) - mediana).sum())},
        "imagen_jpeg": base64.b64encode(jpeg).decode("ascii"),
        "detecciones_representativas": detecciones_rep,
        "cuadricula": asignar_cuadricula(detecciones_rep),
    }
    return ResultadoInspeccion(resultado=resultado, registros=registros, monitor=monitor)


# ---------------------------------------------------------------------------
# Copia local
# ---------------------------------------------------------------------------
COLUMNAS_LATENCIA = ["cuadro", "indice_fuente", "t_s", "calentamiento", "lectura_ms", "preproceso_ms",
                     "inferencia_ms", "posproceso_ms", "publicacion_ms", "total_ms"]
COLUMNAS_CONTEOS = ["cuadro", "indice_fuente", "t_s", *CLASES, "total_detecciones"]


def guardar_csv(carpeta: Path, registros: list[RegistroCuadro]) -> None:
    """Escribe latencias.csv y conteos.csv (una fila por cuadro procesado)."""
    carpeta.mkdir(parents=True, exist_ok=True)
    filas = [asdict(r) for r in registros]
    for nombre, columnas in (("latencias.csv", COLUMNAS_LATENCIA), ("conteos.csv", COLUMNAS_CONTEOS)):
        with open(carpeta / nombre, "w", newline="", encoding="utf-8") as f:
            escritor = csv.writer(f)
            escritor.writerow(columnas)
            for fila in filas:
                escritor.writerow([round(fila[c], 3) if isinstance(fila[c], float) else fila[c] for c in columnas])
