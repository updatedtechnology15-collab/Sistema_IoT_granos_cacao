// Punto de entrada del tablero: rutas por hash y estado del nodo y del broker.
//   #/vivo                     En vivo
//   #/lotes   #/lotes/<id>     Lotes e historial de cada lote
//   #/inspeccion/<id>          Detalle de inspección
//   #/validacion/<id>          Validación
import { conectar, escuchar, estado } from './mqtt_tablero.js';
import * as vivo from './vivo.js';
import * as lotes from './lotes.js';
import * as detalle from './detalle.js';
import * as validacion from './validacion.js';

const paginas = { vivo, lotes, inspeccion: detalle, validacion };
const contenido = document.getElementById('contenido');
let actual = null;

function navegar() {
  const partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const nombre = paginas[partes[0]] ? partes[0] : 'vivo';
  actual?.salir?.();
  contenido.replaceChildren();
  actual = paginas[nombre];
  for (const a of document.querySelectorAll('.pestanas a')) {
    if (a.dataset.pagina === nombre) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  actual.mostrar(contenido, partes.slice(1));
}

function pintarEstados() {
  const nodo = document.getElementById('estado-nodo');
  const broker = document.getElementById('estado-broker');
  const e = estado.nodo?.estado;
  const textos = {
    listo: ['bien', 'Nodo en línea · listo'],
    inspeccionando: ['activo', 'Nodo en línea · inspeccionando'],
    desconectado: ['critico', 'Nodo desconectado'],
  };
  const [tipo, texto] = textos[e] ?? ['', 'Nodo: sin datos'];
  nodo.dataset.estado = tipo;
  nodo.querySelector('.texto').textContent = estado.nodo?.modelo && e !== 'desconectado'
    ? `${texto} (${estado.nodo.modelo}, ${estado.nodo.dispositivo})` : texto;
  broker.dataset.estado = estado.conectado ? 'bien' : 'critico';
  broker.querySelector('.texto').textContent = estado.conectado ? 'Broker conectado' : 'Broker desconectado';
}

escuchar((tipo) => {
  if (tipo === 'estado' || tipo === 'conexion') pintarEstados();
});

window.addEventListener('hashchange', navegar);
navegar();
conectar()
  .then(() => {
    document.getElementById('estacion').textContent = `Estación ${estado.config.estacionId} · NTE INEN 176 · CCN-51`;
  })
  .catch((e) => {
    const broker = document.getElementById('estado-broker');
    broker.dataset.estado = 'critico';
    broker.querySelector('.texto').textContent = `Broker: ${e.message}`;
  });
