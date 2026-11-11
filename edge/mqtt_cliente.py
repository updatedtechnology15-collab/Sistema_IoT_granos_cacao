"""
Cliente MQTT/TLS (puerto 8883) del nodo de borde, con paho-mqtt 2.x.

- Broker EMQX Cloud; credencial "edge" (publica y se suscribe), leída de .env.
- Tópicos cacao/<estacion_id>/{comando, estado, detecciones, cuadro, inspeccion}.
- Estado retenido con QoS 1 y última voluntad "desconectado".
- Todo mensaje publicado lleva ts_pub (ISO 8601 UTC con milisegundos).
"""
from __future__ import annotations

import json
import logging
import os
import queue
import ssl
import threading
import time
from dataclasses import dataclass

import paho.mqtt.client as mqtt
from paho.mqtt.enums import CallbackAPIVersion

from pipeline import ahora_iso

log = logging.getLogger("mqtt")


@dataclass
class Envio:
    """Mensaje entregado a paho y momento (reloj monotónico) en que se entregó."""
    info: mqtt.MQTTMessageInfo
    t_envio: float


class ClienteMQTT:
    def __init__(self, cfg: dict, modelo: str, dispositivo: str):
        self.base = f"cacao/{cfg['estacion_id']}"
        self.modelo = modelo
        self.dispositivo = dispositivo
        self.keepalive = int(cfg.get("mqtt_keepalive_s", 30))

        self.host = os.getenv("MQTT_HOST", "").strip()
        self.puerto = int(os.getenv("MQTT_PORT_TLS", "8883"))
        usuario = os.getenv("EDGE_USER", "").strip()
        clave = os.getenv("EDGE_PASS", "")
        if not self.host or not usuario or not clave:
            raise SystemExit("Faltan MQTT_HOST, EDGE_USER o EDGE_PASS en .env (vea .env.example)")

        self.comandos: queue.Queue[dict] = queue.Queue()
        self.ocupado = False                 # True mientras corre una inspección
        self.estado_actual = "listo"
        self.conectado = threading.Event()
        self._cerrando = False
        # mid -> instante (time.monotonic) de la última confirmación del broker.
        # Los mid se reutilizan; comparar con el instante de envío evita
        # confundir un mensaje nuevo con uno viejo que tuvo el mismo mid.
        self._confirmados: dict[int, float] = {}

        self.cliente = mqtt.Client(CallbackAPIVersion.VERSION2, client_id=f"edge-{cfg['estacion_id']}",
                                   clean_session=True)
        self.cliente.username_pw_set(usuario, clave)
        self.cliente.tls_set_context(ssl.create_default_context())
        # Última voluntad: el broker la publica (retenida) si el nodo se cae sin
        # despedirse. Su hora real de publicación no se conoce de antemano, por eso
        # "ts" va en null y ts_pub es la hora en que se registró la voluntad.
        voluntad = {**self._estado("desconectado"), "ts": None, "ts_pub": ahora_iso()}
        self.cliente.will_set(self.topico("estado"), json.dumps(voluntad), qos=1, retain=True)
        self.cliente.reconnect_delay_set(min_delay=1, max_delay=30)
        self.cliente.on_connect = self._al_conectar
        self.cliente.on_disconnect = self._al_desconectar
        self.cliente.on_message = self._al_recibir
        self.cliente.on_publish = self._al_publicar

    # ------------------------------------------------------------------ util
    def topico(self, sub: str) -> str:
        return f"{self.base}/{sub}"

    def _estado(self, estado: str) -> dict:
        return {"estado": estado, "modelo": self.modelo, "dispositivo": self.dispositivo, "ts": ahora_iso()}

    # ------------------------------------------------------------- conexión
    def conectar(self, espera_s: float = 15.0) -> None:
        log.info("Conectando a %s:%d (TLS)...", self.host, self.puerto)
        self.cliente.connect_async(self.host, self.puerto, keepalive=self.keepalive)
        self.cliente.loop_start()
        if not self.conectado.wait(espera_s):
            log.warning("Sin conexión con el broker tras %.0f s; se sigue intentando en segundo plano", espera_s)

    def cerrar(self) -> None:
        """Publica 'desconectado' (una desconexión limpia no dispara la última voluntad) y cierra."""
        if self.conectado.is_set():
            self.esperar_entrega(self.publicar_estado("desconectado"), 5.0)
        self._cerrando = True
        self.cliente.disconnect()
        self.cliente.loop_stop()

    def _al_conectar(self, cliente, _userdata, _flags, codigo, _props) -> None:
        if codigo.is_failure:
            log.error("El broker rechazó la conexión: %s (revise MQTT_HOST, EDGE_USER y EDGE_PASS "
                      "en .env)", codigo)
            return
        log.info("Conectado al broker")
        self.conectado.set()
        cliente.subscribe(self.topico("comando"), qos=1)
        self.publicar_estado(self.estado_actual)

    def _al_desconectar(self, _cliente, _userdata, _flags, codigo, _props) -> None:
        if self.conectado.is_set() and not self._cerrando:
            log.warning("Desconectado del broker (%s); reintentando", codigo)
        self.conectado.clear()

    def _al_publicar(self, _cliente, _userdata, mid, _codigo, _props) -> None:
        self._confirmados[mid] = time.monotonic()

    def _al_recibir(self, _cliente, _userdata, mensaje) -> None:
        try:
            comando = json.loads(mensaje.payload)
        except (ValueError, UnicodeDecodeError):
            log.warning("Comando ignorado: no es JSON válido")
            return
        if not isinstance(comando, dict) or comando.get("accion") != "iniciar":
            log.warning("Comando ignorado: acción desconocida")
            return
        if self.ocupado or not self.comandos.empty():
            log.warning("Comando ignorado: ya hay una inspección en curso o pendiente")
            return
        self.comandos.put(comando)

    # ---------------------------------------------------------- publicación
    def publicar(self, sub: str, datos: dict, qos: int = 0, retener: bool = False) -> Envio:
        cuerpo = {**datos, "ts_pub": ahora_iso()}
        texto = json.dumps(cuerpo, ensure_ascii=False, separators=(",", ":"))
        t_envio = time.monotonic()
        return Envio(self.cliente.publish(self.topico(sub), texto, qos=qos, retain=retener), t_envio)

    def publicar_estado(self, estado: str) -> Envio:
        self.estado_actual = estado
        return self.publicar("estado", self._estado(estado), qos=1, retener=True)

    def esperar_entrega(self, envio: Envio, espera_s: float) -> bool:
        """Espera la confirmación del broker (PUBACK) de un mensaje QoS 1."""
        limite = time.monotonic() + espera_s
        while time.monotonic() < limite:
            if self._confirmados.get(envio.info.mid, -1.0) >= envio.t_envio:
                return True
            time.sleep(0.05)
        return False
