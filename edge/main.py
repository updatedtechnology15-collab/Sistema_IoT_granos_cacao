"""
Nodo de borde: procesa el video con YOLO26 y publica por MQTT/TLS (8883) en EMQX Cloud.

Uso:
  python edge/main.py
      Espera el comando de inicio en cacao/<estacion_id>/comando.
  python edge/main.py --lote L-001 --fuente videos/Prueba_1_Cacao.mp4
      Ejecuta una inspección por consola, la publica y termina.

--fuente reemplaza a `fuente` de config.yaml (ruta de video, índice de cámara o URL).
"""
from __future__ import annotations

import argparse
import base64
import json
import logging
import queue
import re
import sys
import uuid
from datetime import datetime

from dotenv import load_dotenv

import pipeline as pl
from mqtt_cliente import ClienteMQTT

log = logging.getLogger("nodo")


def nuevo_id_inspeccion() -> str:
    return f"insp-{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:4]}"


# Identificadores aceptados (lote_id e inspeccion_id): los mismos que valida el servidor.
# No pueden empezar con punto, así que nunca forman "." ni ".." en una ruta.
ID_VALIDO = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}")
VENTANA_MAX_S = 600.0


def nombre_carpeta(inspeccion_id: str) -> str:
    """Nombre seguro de carpeta dentro de resultados/ (sin separadores ni '..')."""
    limpio = re.sub(r"[^A-Za-z0-9._-]", "_", inspeccion_id).lstrip(".")
    return limpio or nuevo_id_inspeccion()


def validar_comando(comando: dict, cfg: dict) -> tuple[str, str, float] | None:
    """Devuelve (lote_id, inspeccion_id, ventana_s) o None si el comando no es válido."""
    lote_id = str(comando.get("lote_id") or "").strip()
    inspeccion_id = str(comando.get("inspeccion_id") or nuevo_id_inspeccion()).strip()
    if not ID_VALIDO.fullmatch(lote_id) or not ID_VALIDO.fullmatch(inspeccion_id):
        log.warning("Comando ignorado: lote_id o inspeccion_id no válidos")
        return None
    try:
        ventana_s = float(comando.get("ventana_s") or cfg["ventana_s"])
    except (TypeError, ValueError):
        ventana_s = -1.0
    if not 0 < ventana_s <= VENTANA_MAX_S:
        log.warning("Comando ignorado: ventana_s debe estar entre 0 y %.0f s", VENTANA_MAX_S)
        return None
    return lote_id, inspeccion_id, ventana_s


def correr_inspeccion(detector: pl.Detector, cfg: dict, cliente: ClienteMQTT, fuente,
                      lote_id: str, inspeccion_id: str, ventana_s: float):
    log.info("Inspección %s | lote %s | modelo %s | %s", inspeccion_id, lote_id, detector.nombre,
             detector.dispositivo)
    cliente.ocupado = True
    cliente.publicar_estado("inspeccionando")

    seq = 0
    ultimo_vivo = None
    periodo_vivo = 1.0 / float(cfg["fps_cuadro_vivo"])

    def publicar(cuadro, t_s, imagen, conteos, detecciones, latencia_ms):
        nonlocal seq, ultimo_vivo
        seq += 1
        cliente.publicar("detecciones", {
            "inspeccion_id": inspeccion_id, "seq": seq, "cuadro": cuadro, "t_video_s": round(t_s, 3),
            "conteos": conteos, "detecciones": detecciones, "latencia_ms": round(latencia_ms, 2),
        }, qos=0)
        # Cuadro en vivo solo a fps_cuadro_vivo (mismo reloj que la ventana).
        if ultimo_vivo is None or t_s - ultimo_vivo >= periodo_vivo - 1e-6:
            ultimo_vivo = t_s
            jpeg_b64, ancho, alto = pl.cuadro_vivo(imagen, detecciones, int(cfg["lado_max_vivo"]),
                                                   int(cfg["calidad_jpeg_vivo"]))
            cliente.publicar("cuadro", {"inspeccion_id": inspeccion_id, "cuadro": cuadro,
                                        "jpeg_b64": jpeg_b64, "ancho": ancho, "alto": alto}, qos=0)

    try:
        res = pl.ejecutar_inspeccion(detector, cfg, fuente, ventana_s, publicar)
    finally:
        cliente.ocupado = False
        cliente.publicar_estado("listo")

    mensaje = {"inspeccion_id": inspeccion_id, "lote_id": lote_id, "estacion_id": cfg["estacion_id"],
               **res.resultado, "n_publicados": seq}

    # Copia local: CSV por cuadro, resultado (sin la imagen) e imagen anotada.
    carpeta = pl.ruta_del_proyecto(cfg.get("carpeta_resultados", "resultados")) / nombre_carpeta(inspeccion_id)
    pl.guardar_csv(carpeta, res.registros)
    sin_imagen = {k: v for k, v in mensaje.items() if k != "imagen_jpeg"}
    (carpeta / "inspeccion.json").write_text(json.dumps(sin_imagen, ensure_ascii=False, indent=2), encoding="utf-8")
    (carpeta / "representativo.jpg").write_bytes(base64.b64decode(mensaje["imagen_jpeg"]))

    envio = cliente.publicar("inspeccion", mensaje, qos=1)

    lat = mensaje["latencia"]
    log.info("Conteo (mediana de %d cuadros): %s | total %d", mensaje["n_cuadros"], mensaje["conteos"],
             mensaje["total"])
    log.info("Latencia: media %s ms, DE %s ms, p95 %s ms, fps máx %s | recursos %s | modo %s",
             lat["media_ms"], lat["de_ms"], lat["p95_ms"], lat["fps_max"], mensaje["recursos"],
             mensaje["modo_inferencia"])
    log.info("Cuadrícula: %s", "asignada (100 posiciones)" if isinstance(mensaje["cuadricula"], list)
             else mensaje["cuadricula"])
    log.info("Copia local en %s", carpeta)
    return envio


def main() -> int:
    parser = argparse.ArgumentParser(description="Nodo de borde del ensayo de corte de cacao")
    parser.add_argument("--lote", help="lote_id: ejecuta una inspección por consola y termina")
    parser.add_argument("--fuente", help="ruta de video, índice de cámara o URL (reemplaza a config.yaml)")
    args = parser.parse_args()
    if args.lote is not None and not ID_VALIDO.fullmatch(args.lote):
        parser.error("--lote solo admite letras, números, punto, guion y guion bajo (máx. 64; no empieza con punto)")

    for flujo in (sys.stdout, sys.stderr):  # tildes legibles también al redirigir la salida a un archivo
        flujo.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    load_dotenv(pl.RAIZ / ".env")
    cfg = pl.cargar_config()
    if args.fuente:
        cfg["fuente"] = args.fuente
    fuente = cfg["fuente"]
    pl.interpretar_fuente(fuente)  # falla aquí, y no al recibir el comando, si la fuente no existe

    dispositivo = pl.resolver_dispositivo(cfg["dispositivo"])
    detector = pl.Detector(cfg["modelo"], dispositivo, cfg)
    log.info("Modelo %s cargado en %s", detector.nombre, dispositivo)

    cliente = ClienteMQTT(cfg, modelo=detector.nombre, dispositivo=dispositivo)
    cliente.conectar()
    codigo = 0
    try:
        if args.lote:
            envio = correr_inspeccion(detector, cfg, cliente, fuente, args.lote, nuevo_id_inspeccion(),
                                      float(cfg["ventana_s"]))
            if cliente.esperar_entrega(envio, 60.0):
                log.info("Resultado entregado al broker")
            else:
                log.error("El broker no confirmó el resultado en 60 s; quedó solo la copia local")
                codigo = 1
        else:
            log.info("Esperando comandos en %s (Ctrl+C para salir)", cliente.topico("comando"))
            while True:
                try:
                    comando = cliente.comandos.get(timeout=0.5)  # con espera finita, Ctrl+C funciona en Windows
                except queue.Empty:
                    continue
                valido = validar_comando(comando, cfg)
                if valido is None:
                    continue
                lote_id, inspeccion_id, ventana_s = valido
                try:
                    correr_inspeccion(detector, cfg, cliente, fuente, lote_id, inspeccion_id, ventana_s)
                except Exception:
                    log.exception("La inspección falló")
    except KeyboardInterrupt:
        log.info("Interrumpido por el usuario")
    finally:
        cliente.cerrar()
    return codigo


if __name__ == "__main__":
    sys.exit(main())
